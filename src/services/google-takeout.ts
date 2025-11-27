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
}

export interface TakeoutScanResult {
  totalPhotos: number;
  totalVideos: number;
  totalSize: number;
  photos: TakeoutPhoto[];
  errors: string[];
}

export class GoogleTakeoutService {
  private accountName: string;

  constructor(accountName: string) {
    this.accountName = accountName;
  }

  async scanTakeoutFolder(folderPath: string, onProgress?: (count: number) => void): Promise<TakeoutScanResult> {
    logger.info(`Scanning Google Takeout folder for ${this.accountName}: ${folderPath}`);

    if (!fs.existsSync(folderPath)) {
      throw new Error(`Takeout folder not found: ${folderPath}`);
    }

    const result: TakeoutScanResult = {
      totalPhotos: 0,
      totalVideos: 0,
      totalSize: 0,
      photos: [],
      errors: [],
    };

    await this.scanDirectory(folderPath, result, onProgress);

    logger.info(
      `Takeout scan complete for ${this.accountName}: ` +
      `${result.totalPhotos} photos, ${result.totalVideos} videos, ` +
      `${(result.totalSize / 1024 / 1024 / 1024).toFixed(2)} GB total`
    );

    return result;
  }

  private async scanDirectory(
    dirPath: string,
    result: TakeoutScanResult,
    onProgress?: (count: number) => void
  ): Promise<void> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        await this.scanDirectory(fullPath, result, onProgress);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();

        // Skip metadata JSON files and non-media files
        if (ext === '.json' || !SUPPORTED_EXTENSIONS.includes(ext)) {
          continue;
        }

        try {
          const photo = await this.processMediaFile(fullPath);
          if (photo) {
            result.photos.push(photo);
            result.totalSize += photo.fileSize;

            if (IMAGE_EXTENSIONS.includes(ext)) {
              result.totalPhotos++;
            } else if (VIDEO_EXTENSIONS.includes(ext)) {
              result.totalVideos++;
            }

            if (onProgress) {
              onProgress(result.photos.length);
            }
          }
        } catch (error) {
          result.errors.push(`Error processing ${fullPath}: ${error}`);
          logger.warn(`Error processing file ${fullPath}: ${error}`);
        }
      }
    }
  }

  private async processMediaFile(filePath: string): Promise<TakeoutPhoto | null> {
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
      };

      insertPhoto(record);
      imported++;
    }

    logger.info(`Imported ${imported} photos to database`);
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
