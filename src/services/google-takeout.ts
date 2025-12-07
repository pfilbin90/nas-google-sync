import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { PhotoRecord, insertPhoto } from '../models/database.js';

interface TakeoutMetadata {
  title?: string;
  description?: string;
  imageViews?: string;
  creationTime?: {
    timestamp?: string;
    formatted?: string;
  };
  photoTakenTime?: {
    timestamp?: string;
    formatted?: string;
  };
  geoData?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
  };
  geoDataExif?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
  };
  googlePhotosOrigin?: {
    mobileUpload?: {
      deviceType?: string;
    };
  };
}

const SUPPORTED_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tiff', '.tif',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp', '.wmv'
];

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tiff', '.tif'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp', '.wmv'];

export interface TakeoutPhoto {
  filePath: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  creationTime: string;
  hash: string;
  metadata?: TakeoutMetadata;
  accountName: string;
  albumName?: string;  // Album name extracted from folder structure
}

export interface TakeoutScanResult {
  totalPhotos: number;
  totalVideos: number;
  totalSize: number;
  photos: TakeoutPhoto[];
  errors: string[];
  albumsFound: Map<string, number>;  // Album name -> photo count
}

export interface ScanOptions {
  concurrency?: number;  // Number of parallel file processing workers (default: 4)
}

interface FileToProcess {
  fullPath: string;
  ext: string;
  albumName: string | undefined;
}

export class GoogleTakeoutService {
  private accountName: string;

  constructor(accountName: string) {
    this.accountName = accountName;
  }

  async scanTakeoutFolder(
    folderPath: string,
    onProgress?: (count: number) => void,
    options?: ScanOptions
  ): Promise<TakeoutScanResult> {
    const concurrency = options?.concurrency ?? 4;
    logger.info(`Scanning Google Takeout folder for ${this.accountName}: ${folderPath} (concurrency: ${concurrency})`);

    if (!fs.existsSync(folderPath)) {
      throw new Error(`Takeout folder not found: ${folderPath}`);
    }

    const result: TakeoutScanResult = {
      totalPhotos: 0,
      totalVideos: 0,
      totalSize: 0,
      photos: [],
      errors: [],
      albumsFound: new Map(),
    };

    // Phase 1: Quickly collect all files to process (fast, single-threaded directory walk)
    const filesToProcess: FileToProcess[] = [];
    this.collectFiles(folderPath, folderPath, filesToProcess);

    logger.info(`Found ${filesToProcess.length} media files to process`);

    // Phase 2: Process files in parallel batches
    let processedCount = 0;

    // Process in chunks to control concurrency
    for (let i = 0; i < filesToProcess.length; i += concurrency) {
      const batch = filesToProcess.slice(i, i + concurrency);

      const batchResults = await Promise.all(
        batch.map(async (file) => {
          try {
            const photo = await this.processMediaFile(file.fullPath, file.albumName);
            return { photo, file, error: null };
          } catch (error) {
            return { photo: null, file, error: `Error processing ${file.fullPath}: ${error}` };
          }
        })
      );

      // Collect results from this batch
      for (const { photo, file, error } of batchResults) {
        if (error) {
          result.errors.push(error);
          logger.warn(error);
        } else if (photo) {
          result.photos.push(photo);
          result.totalSize += photo.fileSize;

          if (IMAGE_EXTENSIONS.includes(file.ext)) {
            result.totalPhotos++;
          } else if (VIDEO_EXTENSIONS.includes(file.ext)) {
            result.totalVideos++;
          }

          // Track album statistics
          if (file.albumName) {
            result.albumsFound.set(file.albumName, (result.albumsFound.get(file.albumName) || 0) + 1);
          }
        }
        processedCount++;
      }

      if (onProgress) {
        onProgress(processedCount);
      }
    }

    logger.info(
      `Takeout scan complete for ${this.accountName}: ` +
      `${result.totalPhotos} photos, ${result.totalVideos} videos, ` +
      `${(result.totalSize / 1024 / 1024 / 1024).toFixed(2)} GB total, ` +
      `${result.albumsFound.size} albums detected`
    );

    return result;
  }

  /**
   * Quickly collect all media files without processing them (fast directory walk)
   */
  private collectFiles(
    dirPath: string,
    rootPath: string,
    files: FileToProcess[]
  ): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        this.collectFiles(fullPath, rootPath, files);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();

        if (ext !== '.json' && SUPPORTED_EXTENSIONS.includes(ext)) {
          const albumName = this.extractAlbumName(dirPath, rootPath);
          files.push({ fullPath, ext, albumName });
        }
      }
    }
  }

  /**
   * Extract album name from the folder path relative to root.
   * Google Takeout typically structures photos as:
   * - Google Photos/Album Name/photo.jpg
   * - Google Photos/Photos from YYYY/photo.jpg (date-based, not a real album)
   * - Google Photos/photo.jpg (root level, no album)
   */
  private extractAlbumName(dirPath: string, rootPath: string): string | undefined {
    // Get the relative path from root
    const relativePath = path.relative(rootPath, dirPath);

    if (!relativePath || relativePath === '.') {
      // Photo is in root folder, no album
      return undefined;
    }

    // Split the path into parts
    const pathParts = relativePath.split(path.sep);

    // The first folder after root is the album name
    const potentialAlbum = pathParts[0];

    // Skip folders that aren't real albums:
    // - "Photos from YYYY" - auto-generated date folders
    // - "Untitled" - empty album name
    // - Date-pattern folders like "2024-01-15"
    const skipPatterns = [
      /^Photos from \d{4}$/i,
      /^Untitled$/i,
      /^\d{4}$/,           // Just a year
      /^\d{4}-\d{2}$/,     // YYYY-MM
      /^\d{4}-\d{2}-\d{2}$/, // YYYY-MM-DD
      /^Archive$/i,        // Generic Archive folder
      /^Trash$/i,          // Trash folder
      /^Edited$/i,         // Edited photos folder
    ];

    for (const pattern of skipPatterns) {
      if (pattern.test(potentialAlbum)) {
        return undefined;
      }
    }

    return potentialAlbum;
  }

  private async processMediaFile(filePath: string, albumName?: string): Promise<TakeoutPhoto | null> {
    const stats = fs.statSync(filePath);
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();

    // Try to find accompanying metadata JSON file
    const metadata = this.loadMetadata(filePath);

    // Determine creation time from metadata or file stats
    let creationTime: string;
    if (metadata?.photoTakenTime?.timestamp) {
      creationTime = new Date(parseInt(metadata.photoTakenTime.timestamp) * 1000).toISOString();
    } else if (metadata?.creationTime?.timestamp) {
      creationTime = new Date(parseInt(metadata.creationTime.timestamp) * 1000).toISOString();
    } else {
      creationTime = stats.birthtime.toISOString();
    }

    // Calculate file hash for duplicate detection
    const hash = await this.calculateFileHash(filePath);

    // Determine MIME type
    const mimeType = this.getMimeType(ext);

    return {
      filePath,
      filename,
      mimeType,
      fileSize: stats.size,
      creationTime,
      hash,
      metadata,
      accountName: this.accountName,
      albumName,
    };
  }

  private loadMetadata(mediaFilePath: string): TakeoutMetadata | undefined {
    const dir = path.dirname(mediaFilePath);
    const filename = path.basename(mediaFilePath);
    const basename = path.basename(mediaFilePath, path.extname(mediaFilePath));

    // Google Takeout uses different JSON naming conventions depending on export date:
    // 1. Newer exports: "IMG_1234.jpg.supplemental-metadata.json"
    // 2. Older exports: "IMG_1234.jpg.json"
    // 3. Sometimes: "IMG_1234.json" (without extension)
    const possibleJsonPaths = [
      `${mediaFilePath}.supplemental-metadata.json`,
      `${mediaFilePath}.json`,
      path.join(dir, `${basename}.json`),
      path.join(dir, `${filename}.json`),
    ];

    for (const jsonPath of possibleJsonPaths) {
      if (fs.existsSync(jsonPath)) {
        try {
          const content = fs.readFileSync(jsonPath, 'utf-8');
          return JSON.parse(content) as TakeoutMetadata;
        } catch (error) {
          logger.debug(`Could not parse metadata at ${jsonPath}: ${error}`);
        }
      }
    }

    return undefined;
  }

  private async calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private getMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.heic': 'image/heic',
      '.heif': 'image/heif',
      '.bmp': 'image/bmp',
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
      '.m4v': 'video/x-m4v',
      '.3gp': 'video/3gpp',
      '.wmv': 'video/x-ms-wmv',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Import scanned takeout photos into the database
   */
  async importToDatabase(photos: TakeoutPhoto[]): Promise<number> {
    logger.info(`Importing ${photos.length} photos from takeout to database...`);

    let imported = 0;
    for (const photo of photos) {
      const record: PhotoRecord = {
        id: `takeout-${this.accountName}-${photo.hash}`,
        source: 'google',
        accountName: this.accountName,
        filename: photo.filename,
        mimeType: photo.mimeType,
        creationTime: photo.creationTime,
        fileSize: photo.fileSize,
        hash: photo.hash,
        googleMediaItemId: undefined,
        synologyPath: photo.filePath, // Store the original file path for later upload
        isBackedUp: false,
        canBeRemoved: false,
        lastScannedAt: new Date().toISOString(),
        albumName: photo.albumName,
      };

      insertPhoto(record);
      imported++;
    }

    logger.info(`Imported ${imported} photos to database`);
    return imported;
  }

  /**
   * Import photos that are already backed up to Synology
   * These are tracked so the export command knows they're safe to delete from Google
   */
  async importAsBackedUp(photos: TakeoutPhoto[]): Promise<number> {
    if (photos.length === 0) return 0;

    logger.info(`Recording ${photos.length} photos already backed up to Synology...`);

    let imported = 0;
    for (const photo of photos) {
      const record: PhotoRecord = {
        id: `takeout-${this.accountName}-${photo.hash}`,
        source: 'google',
        accountName: this.accountName,
        filename: photo.filename,
        mimeType: photo.mimeType,
        creationTime: photo.creationTime,
        fileSize: photo.fileSize,
        hash: photo.hash,
        googleMediaItemId: undefined,
        synologyPath: photo.filePath,
        isBackedUp: true,  // Already on Synology
        canBeRemoved: true, // Safe to delete from Google
        lastScannedAt: new Date().toISOString(),
        albumName: photo.albumName,
      };

      insertPhoto(record);
      imported++;
    }

    logger.info(`Recorded ${imported} already-backed-up photos`);
    return imported;
  }
}

/**
 * Extract a Google Takeout zip file
 */
export async function extractTakeoutZip(zipPath: string, destPath: string): Promise<string> {
  const AdmZip = (await import('adm-zip')).default;

  logger.info(`Extracting ${zipPath} to ${destPath}...`);

  if (!fs.existsSync(zipPath)) {
    throw new Error(`Zip file not found: ${zipPath}`);
  }

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destPath, true);

  logger.info(`Extraction complete: ${destPath}`);
  return destPath;
}
