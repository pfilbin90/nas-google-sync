import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SynologyAccountConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { PhotoRecord, insertPhoto, updateStorageStats } from '../models/database.js';

interface SynologyApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: number;
    errors?: any;
  };
}

interface SynologyAuthResponse {
  sid: string;
  did?: string;
}

interface SynologyPhoto {
  id: number;
  filename: string;
  filesize: number;
  time: number;
  indexed_time: number;
  type: string;
  additional?: {
    resolution?: {
      width: number;
      height: number;
    };
    orientation?: number;
    thumbnail?: {
      m: string;
      xl: string;
    };
  };
}

interface SynologyFolder {
  id: number;
  name: string;
  parent: number;
  passphrase: string;
  shared: boolean;
  sort_by: string;
  sort_direction: string;
}

interface SynologyAlbum {
  id: number;
  name: string;
  item_count?: number;
  create_time?: number;
  end_time?: number;
  freeze_album?: boolean;
  owner_user_id?: number;
  passphrase?: string;
  shared?: boolean;
  sort_by?: string;
  sort_direction?: string;
  start_time?: number;
  type?: string;
  version?: number;
}

export class SynologyPhotosService {
  private config: SynologyAccountConfig;
  private client: AxiosInstance;
  private sid: string | null = null;

  constructor(config: SynologyAccountConfig) {
    this.config = config;
    const protocol = config.useSsl ? 'https' : 'http';
    this.client = axios.create({
      baseURL: `${protocol}://${config.host}:${config.port}`,
      timeout: 30000,
    });
  }

  get accountName(): string {
    return this.config.name;
  }

  async authenticate(): Promise<void> {
    logger.info(`Authenticating with Synology NAS at ${this.config.host}...`);

    try {
      const response = await this.client.get<SynologyApiResponse<SynologyAuthResponse>>(
        '/webapi/auth.cgi',
        {
          params: {
            api: 'SYNO.API.Auth',
            version: 6,
            method: 'login',
            account: this.config.username,
            passwd: this.config.password,
            session: 'PhotoStation',
            format: 'sid',
          },
        }
      );

      if (!response.data.success || !response.data.data?.sid) {
        throw new Error(`Synology authentication failed: ${JSON.stringify(response.data.error)}`);
      }

      this.sid = response.data.data.sid;
      logger.info('Synology authentication successful');
    } catch (error) {
      logger.error(`Synology authentication error: ${error}`);
      throw error;
    }
  }

  async logout(): Promise<void> {
    if (!this.sid) return;

    try {
      await this.client.get('/webapi/auth.cgi', {
        params: {
          api: 'SYNO.API.Auth',
          version: 6,
          method: 'logout',
          session: 'PhotoStation',
        },
      });
      this.sid = null;
      logger.info('Synology logout successful');
    } catch (error) {
      logger.warn(`Synology logout error: ${error}`);
    }
  }

  async getStorageInfo(): Promise<{ used: number; total: number; percentUsed: number }> {
    if (!this.sid) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    try {
      // Get volume info using DSM API
      const response = await this.client.get<SynologyApiResponse>(
        '/webapi/entry.cgi',
        {
          params: {
            api: 'SYNO.Core.System',
            version: 1,
            method: 'info',
            type: 'storage',
            _sid: this.sid,
          },
        }
      );

      if (response.data.success && response.data.data?.vol_info) {
        const volumes = response.data.data.vol_info;
        // Find volume_1 (main storage) - the vol_info uses name like "volume_1" or "volume_2"
        // Prefer volume_1 as that's typically where user data lives, not surveillance
        const photoVolume = volumes.find((v: any) =>
          v.name === 'volume_1' || v.volume === 'volume_1'
        ) || volumes.find((v: any) =>
          // Fallback: find the largest volume (likely main storage, not surveillance)
          !v.vol_desc?.toLowerCase().includes('surveillance')
        ) || volumes[0];

        if (photoVolume) {
          const used = photoVolume.used_size || 0;
          const total = photoVolume.total_size || 0;
          const percentUsed = total > 0 ? (used / total) * 100 : 0;

          updateStorageStats({
            source: 'synology',
            accountName: 'NAS',
            usedBytes: used,
            totalBytes: total,
            percentUsed,
            lastCheckedAt: new Date().toISOString(),
          });

          logger.info(
            `Synology storage: ${(used / 1024 / 1024 / 1024).toFixed(2)} GB / ` +
            `${(total / 1024 / 1024 / 1024).toFixed(2)} GB (${percentUsed.toFixed(1)}%)`
          );

          return { used, total, percentUsed };
        }
      }

      logger.warn('Could not retrieve Synology storage info');
      return { used: 0, total: 0, percentUsed: 0 };
    } catch (error) {
      logger.error(`Failed to get Synology storage info: ${error}`);
      return { used: 0, total: 0, percentUsed: 0 };
    }
  }

  async scanAllPhotos(onProgress?: (count: number) => void): Promise<number> {
    if (!this.sid) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    logger.info(`Starting full scan of Synology Photos for ${this.config.name}...`);

    let totalCount = 0;

    // Scan Personal Space (user's private photos)
    logger.info(`Scanning Personal Space...`);
    const personalCount = await this.scanSpace('personal', (count) => {
      totalCount = count;
      if (onProgress) onProgress(totalCount);
    });
    logger.info(`Personal Space: ${personalCount} photos found`);

    // Scan Shared Space (photos in /photo shared folder)
    logger.info(`Scanning Shared Space...`);
    const sharedCount = await this.scanSpace('shared', (count) => {
      totalCount = personalCount + count;
      if (onProgress) onProgress(totalCount);
    });
    logger.info(`Shared Space: ${sharedCount} photos found`);

    totalCount = personalCount + sharedCount;
    logger.info(`Synology scan complete for ${this.config.name}: ${totalCount} photos total (${personalCount} personal, ${sharedCount} shared)`);
    return totalCount;
  }

  private async scanSpace(
    space: 'personal' | 'shared',
    onProgress?: (count: number) => void
  ): Promise<number> {
    let offset = 0;
    let count = 0;
    const limit = 100;

    do {
      const response = await this.fetchPhotos(offset, limit, space);

      if (!response.success || !response.data?.list) {
        break;
      }

      const photos = response.data.list;
      if (photos.length === 0) break;

      for (const photo of photos) {
        await this.processPhoto(photo, space);
        count++;
      }

      if (onProgress) {
        onProgress(count);
      }

      offset += limit;

      // Rate limiting
      await this.delay(50);
    } while (true);

    return count;
  }

  private async fetchPhotos(
    offset: number,
    limit: number,
    space: 'personal' | 'shared' = 'personal'
  ): Promise<SynologyApiResponse<{ list: SynologyPhoto[] }>> {
    // Use different API for personal vs shared space
    const api = space === 'shared' ? 'SYNO.FotoTeam.Browse.Item' : 'SYNO.Foto.Browse.Item';

    try {
      const response = await this.client.get<SynologyApiResponse<{ list: SynologyPhoto[] }>>(
        '/webapi/entry.cgi',
        {
          params: {
            api,
            version: 1,
            method: 'list',
            offset,
            limit,
            additional: '["resolution","orientation","thumbnail"]',
            _sid: this.sid,
          },
        }
      );

      if (response.data.success) {
        return response.data;
      }
    } catch (error) {
      logger.debug(`${api} failed: ${error}`);
    }

    // Fallback to Photo Station API (DSM 6) - only for personal space
    if (space === 'personal') {
      try {
        const response = await this.client.get<SynologyApiResponse>(
          '/webapi/PhotoStation/photo.cgi',
          {
            params: {
              api: 'SYNO.PhotoStation.Photo',
              version: 1,
              method: 'list',
              offset,
              limit,
              type: 'photo,video',
              additional: 'photo_exif,video_codec,video_quality,thumb_size',
              _sid: this.sid,
            },
          }
        );

        return response.data;
      } catch (error) {
        logger.error(`Failed to fetch photos: ${error}`);
      }
    }

    return { success: false };
  }

  private async processPhoto(photo: SynologyPhoto, space: 'personal' | 'shared' = 'personal'): Promise<void> {
    const hash = this.generateContentHash(photo);

    // For shared space, use a global ID so multiple users scanning don't create duplicates
    // For personal space, include account name since each user has their own personal photos
    const id = space === 'shared'
      ? `synology-shared-${photo.id}`
      : `synology-${this.config.name}-personal-${photo.id}`;

    // For shared photos, use a generic account name and path
    const accountName = space === 'shared' ? '_shared' : this.config.name;
    const photoPath = space === 'shared'
      ? `/photo/${photo.filename}`
      : `${this.config.photoLibraryPath}/${photo.filename}`;

    const photoRecord: PhotoRecord = {
      id,
      source: 'synology',
      accountName,
      filename: photo.filename,
      mimeType: this.getMimeType(photo.filename, photo.type),
      creationTime: new Date(photo.time * 1000).toISOString(),
      width: photo.additional?.resolution?.width,
      height: photo.additional?.resolution?.height,
      fileSize: photo.filesize,
      hash,
      synologyPath: photoPath,
      synologyPhotoId: photo.id, // Store Synology's internal photo ID for album management
      isBackedUp: true, // Already on NAS
      canBeRemoved: false,
      lastScannedAt: new Date().toISOString(),
    };

    insertPhoto(photoRecord);
  }

  private generateContentHash(photo: SynologyPhoto): string {
    const hashContent = [
      photo.filename,
      photo.filesize,
      photo.time,
      photo.additional?.resolution?.width,
      photo.additional?.resolution?.height,
    ].filter(Boolean).join('|');

    return crypto.createHash('sha256').update(hashContent).digest('hex').substring(0, 32);
  }

  private getMimeType(filename: string, type: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.heic': 'image/heic',
      '.heif': 'image/heif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska',
    };
    return mimeTypes[ext] || (type === 'video' ? 'video/mp4' : 'image/jpeg');
  }

  async uploadPhoto(buffer: Buffer, filename: string, destinationFolder?: string): Promise<boolean> {
    if (!this.sid) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    const destPath = destinationFolder || this.config.photoLibraryPath;

    try {
      const FormData = (await import('form-data')).default;
      const form = new FormData();

      // For multipart uploads, only include the required form fields
      form.append('path', destPath);
      form.append('create_parents', 'true');
      form.append('overwrite', 'false');
      form.append('file', buffer, {
        filename,
        contentType: this.getMimeType(filename, 'photo'),
      });

      // SID and API params go in the URL query string for multipart uploads
      const response = await this.client.post<SynologyApiResponse>(
        '/webapi/entry.cgi',
        form,
        {
          params: {
            api: 'SYNO.FileStation.Upload',
            version: 2,
            method: 'upload',
            _sid: this.sid,
          },
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 120000,
        }
      );

      if (response.data.success) {
        logger.info(`Uploaded ${filename} to Synology Photos`);
        return true;
      } else {
        logger.error(`Failed to upload ${filename}: ${JSON.stringify(response.data.error)}`);
        return false;
      }
    } catch (error) {
      logger.error(`Upload error for ${filename}: ${error}`);
      return false;
    }
  }

  async createFolder(folderName: string, parentId: number = 0): Promise<number | null> {
    if (!this.sid) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    try {
      const response = await this.client.get<SynologyApiResponse<{ folder: SynologyFolder }>>(
        '/webapi/entry.cgi',
        {
          params: {
            api: 'SYNO.Foto.Browse.Folder',
            version: 1,
            method: 'create',
            name: folderName,
            target_id: parentId,
            _sid: this.sid,
          },
        }
      );

      if (response.data.success && response.data.data?.folder) {
        return response.data.data.folder.id;
      }
      return null;
    } catch (error) {
      logger.error(`Failed to create folder ${folderName}: ${error}`);
      return null;
    }
  }

  // ===== Album Management API Methods =====

  /**
   * List all albums from Synology Photos with automatic pagination.
   *
   * @returns Array of all albums (handles pagination automatically)
   */
  async listAlbums(): Promise<SynologyAlbum[]> {
    if (!this.sid) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    const allAlbums: SynologyAlbum[] = [];
    let offset = 0;
    const limit = 1000;

    try {
      while (true) {
        const response = await this.client.get<SynologyApiResponse<{ list: SynologyAlbum[] }>>(
          '/webapi/entry.cgi',
          {
            params: {
              api: 'SYNO.Foto.Browse.Album',
              method: 'list',
              version: 1,
              _sid: this.sid,
              offset,
              limit,
            },
          }
        );

        if (!response.data.success) {
          throw new Error(`Failed to list albums: ${JSON.stringify(response.data.error)}`);
        }

        const albums = response.data.data?.list || [];
        if (albums.length === 0) {
          break; // No more albums
        }

        allAlbums.push(...albums);

        // If we got fewer albums than the limit, we've reached the end
        if (albums.length < limit) {
          break;
        }

        offset += limit;
      }

      logger.debug(`Listed ${allAlbums.length} albums from Synology Photos`);
      return allAlbums;
    } catch (error) {
      logger.error(`Failed to list albums: ${error}`);
      throw error;
    }
  }

  /**
   * Get or create an album by name.
   * Returns the Synology album ID and whether it was newly created.
   *
   * @param albumName - Name of the album
   * @param existingAlbums - Optional pre-fetched list of albums to avoid redundant API calls
   * @returns Object containing albumId and wasCreated flag
   */
  async getOrCreateAlbum(
    albumName: string,
    existingAlbums?: SynologyAlbum[]
  ): Promise<{ albumId: number; wasCreated: boolean }> {
    if (!this.sid) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    // Use provided albums list or fetch if not provided
    const albums = existingAlbums ?? await this.listAlbums();
    const existing = albums.find((a) => a.name === albumName);

    if (existing) {
      logger.debug(`Found existing album "${albumName}" (ID: ${existing.id})`);
      return { albumId: existing.id, wasCreated: false };
    }

    // Create new album
    try {
      const response = await this.client.get<SynologyApiResponse<{ album: SynologyAlbum }>>(
        '/webapi/entry.cgi',
        {
          params: {
            api: 'SYNO.Foto.Browse.NormalAlbum',
            method: 'create',
            version: 1,
            _sid: this.sid,
            name: albumName,
          },
        }
      );

      if (!response.data.success) {
        const errorCode = response.data.error?.code;

        // Handle concurrent creation: if album was created by another process between our check and create,
        // treat it as success by re-fetching the album list to find the existing album
        // Common error code for "already exists": 408 (duplicate name)
        if (errorCode === 408) {
          logger.debug(`Album "${albumName}" already exists (concurrent creation), fetching existing album`);
          const refreshedAlbums = await this.listAlbums();
          const existing = refreshedAlbums.find((a) => a.name === albumName);

          if (existing) {
            if (existingAlbums) {
              existingAlbums.push(existing);
            }
            return { albumId: existing.id, wasCreated: false };
          }
        }

        throw new Error(`Failed to create album "${albumName}": ${JSON.stringify(response.data.error)}`);
      }

      const createdAlbum = response.data.data?.album;
      const albumId = createdAlbum?.id;
      if (!albumId) {
        throw new Error(`Album created but no ID returned for "${albumName}"`);
      }

      // Add the newly created album to the existingAlbums cache if provided
      // This avoids duplicate creation attempts in the same run
      if (existingAlbums && createdAlbum) {
        existingAlbums.push(createdAlbum);
      }

      logger.info(`Created album "${albumName}" (ID: ${albumId})`);
      return { albumId, wasCreated: true };
    } catch (error) {
      logger.error(`Failed to create album "${albumName}": ${error}`);
      throw error;
    }
  }

  /**
   * List folders under a specific parent folder with automatic pagination.
   * Note: This is NOT recursive - it only lists immediate children of the parent.
   *
   * @param parentId - Parent folder ID (0 for root)
   * @returns Array of folders under the specified parent (handles pagination automatically)
   * @throws Error if the first page fails (distinguishes hard failure from empty folder)
   */
  async listFolders(parentId: number = 0): Promise<SynologyFolder[]> {
    if (!this.sid) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    const allFolders: SynologyFolder[] = [];
    let offset = 0;
    const limit = 1000;

    try {
      while (true) {
        const response = await this.client.get<SynologyApiResponse<{ list: SynologyFolder[] }>>(
          '/webapi/entry.cgi',
          {
            params: {
              api: 'SYNO.Foto.Browse.Folder',
              method: 'list',
              version: 1,
              _sid: this.sid,
              id: parentId,
              offset,
              limit,
            },
          }
        );

        if (!response.data.success) {
          // If we fail on the first page with no data yet, throw to indicate hard failure
          if (allFolders.length === 0) {
            throw new Error(`Failed to list folders: ${JSON.stringify(response.data.error)}`);
          }
          // If we got some folders already, log warning and return what we have
          logger.warn(`Partial failure listing folders (got ${allFolders.length} so far): ${JSON.stringify(response.data.error)}`);
          return allFolders;
        }

        const folders = response.data.data?.list || [];
        if (folders.length === 0) {
          break; // No more folders
        }

        allFolders.push(...folders);

        // If we got fewer folders than the limit, we've reached the end
        if (folders.length < limit) {
          break;
        }

        offset += limit;
      }

      logger.debug(`Listed ${allFolders.length} folders from Synology Photos`);
      return allFolders;
    } catch (error) {
      // If we fail with no data, rethrow to indicate hard failure
      if (allFolders.length === 0) {
        logger.error(`Failed to list folders: ${error}`);
        throw error;
      }
      // If we got partial data, log and return what we have
      logger.warn(`Partial failure listing folders (got ${allFolders.length}): ${error}`);
      return allFolders;
    }
  }

  /**
   * Find a photo by filename in the library.
   * Uses the Synology search API to find the photo ID.
   * Returns the Synology photo ID or null if not found.
   *
   * Note: Searches up to 500 results to handle edge cases with generic filenames.
   *
   * @throws Error on network failures or unexpected API errors (distinguishes from "not found")
   * @returns Photo ID if found, null if not found or search API unavailable
   */
  async findPhotoByFilename(filename: string): Promise<number | null> {
    if (!this.sid) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    try {
      const limit = 100;
      const maxResults = 500; // Search up to 500 results for edge cases
      let offset = 0;

      // Search with pagination to handle generic filenames
      while (offset < maxResults) {
        const response = await this.client.get<SynologyApiResponse<{ list: SynologyPhoto[] }>>(
          '/webapi/entry.cgi',
          {
            params: {
              api: 'SYNO.Foto.Search.Search',
              method: 'list_item',
              version: 1,
              _sid: this.sid,
              keyword: filename,
              offset,
              limit,
            },
          }
        );

        if (!response.data.success) {
          const errorCode = response.data.error?.code;

          // Gracefully handle "API not available" or "method not found" errors
          // These indicate the search API isn't supported on this Synology version
          if (errorCode === 101 || errorCode === 102 || errorCode === 103) {
            logger.debug(`Search API not available for "${filename}" (error ${errorCode})`);
            return null;
          }

          // For other API errors, throw to distinguish from "not found"
          throw new Error(`Search API error for "${filename}": ${JSON.stringify(response.data.error)}`);
        }

        const items = response.data.data?.list || [];

        // Find exact match in this batch
        const photo = items.find((item) => item.filename === filename);
        if (photo) {
          logger.debug(`Found photo "${filename}" (ID: ${photo.id})`);
          return photo.id;
        }

        // If we got fewer items than the limit, we've seen all results
        if (items.length < limit) {
          break;
        }

        offset += limit;
      }

      logger.debug(`Photo not found: ${filename}`);
      return null;
    } catch (error) {
      // Network errors and unexpected failures should be thrown to indicate transient issues
      // Only log as debug if it's our own graceful "API not available" error
      if (error instanceof Error && error.message.includes('not available')) {
        logger.debug(error.message);
        return null;
      }

      // Rethrow unexpected errors (network, auth, etc.) so caller can handle or retry
      logger.warn(`Error searching for photo "${filename}": ${error}`);
      throw error;
    }
  }

  /**
   * Get photos in a folder by folder ID
   */
  async getPhotosInFolder(folderId: number, offset: number = 0, limit: number = 1000): Promise<SynologyPhoto[]> {
    if (!this.sid) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    try {
      const response = await this.client.get<SynologyApiResponse<{ list: SynologyPhoto[] }>>(
        '/webapi/entry.cgi',
        {
          params: {
            api: 'SYNO.Foto.Browse.Item',
            method: 'list',
            version: 1,
            _sid: this.sid,
            folder_id: folderId,
            offset,
            limit,
            additional: JSON.stringify(['thumbnail']),
          },
        }
      );

      if (!response.data.success) {
        logger.warn(`Failed to list items in folder ${folderId}: ${JSON.stringify(response.data.error)}`);
        return [];
      }

      return response.data.data?.list || [];
    } catch (error) {
      logger.error(`Failed to list items in folder ${folderId}: ${error}`);
      return [];
    }
  }

  /**
   * Add photos to an album by their Synology photo IDs.
   * Automatically chunks large arrays to avoid query string limits.
   *
   * @param albumId - Synology album ID
   * @param photoIds - Array of Synology photo IDs to add
   * @param chunkSize - Maximum photos per API call (default: 500)
   * @returns True if all photos were added successfully
   */
  async addItemsToAlbum(albumId: number, photoIds: number[], chunkSize: number = 500): Promise<boolean> {
    if (!this.sid) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    if (photoIds.length === 0) {
      return true;
    }

    try {
      // Split into chunks to avoid very large query strings
      const chunks: number[][] = [];
      for (let i = 0; i < photoIds.length; i += chunkSize) {
        chunks.push(photoIds.slice(i, i + chunkSize));
      }

      // Process each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const response = await this.client.get<SynologyApiResponse>(
          '/webapi/entry.cgi',
          {
            params: {
              api: 'SYNO.Foto.Browse.NormalAlbum',
              method: 'add_item',
              version: 1,
              _sid: this.sid,
              id: albumId,
              item: JSON.stringify(chunk),
            },
          }
        );

        if (!response.data.success) {
          logger.error(`Failed to add chunk ${i + 1}/${chunks.length} to album ${albumId}: ${JSON.stringify(response.data.error)}`);
          return false;
        }

        logger.debug(`Added chunk ${i + 1}/${chunks.length} (${chunk.length} photos) to album ${albumId}`);
      }

      logger.info(`Added ${photoIds.length} photos to album ${albumId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to add items to album ${albumId}: ${error}`);
      return false;
    }
  }

  /**
   * Batch lookup photo IDs by filename with deduplication and optional concurrency.
   * More efficient for processing many photos.
   *
   * @param filenames - Array of filenames to look up
   * @param onProgress - Optional progress callback (found count, total count)
   * @param concurrency - Number of concurrent lookups (default: 1, max recommended: 5)
   * @returns Map of filename to Synology photo ID
   */
  async batchFindPhotoIds(
    filenames: string[],
    onProgress?: (found: number, total: number) => void,
    concurrency: number = 1
  ): Promise<Map<string, number>> {
    // Deduplicate filenames to avoid redundant lookups
    const uniqueFilenames = [...new Set(filenames)];
    const results = new Map<string, number>();

    // Clamp concurrency to reasonable bounds
    const safeConcurrency = Math.max(1, Math.min(concurrency, 5));

    // Helper to process a single filename lookup and update results
    const processLookup = (filename: string, photoId: number | null) => {
      if (photoId !== null) {
        results.set(filename, photoId);
      }
    };

    if (safeConcurrency === 1) {
      // Sequential processing (original behavior)
      for (const filename of uniqueFilenames) {
        const photoId = await this.findPhotoByFilename(filename);
        processLookup(filename, photoId);

        if (onProgress) {
          onProgress(results.size, uniqueFilenames.length);
        }

        // Small delay to avoid rate limiting
        await this.delay(100);
      }
    } else {
      // Concurrent processing with limited parallelism
      for (let i = 0; i < uniqueFilenames.length; i += safeConcurrency) {
        const batch = uniqueFilenames.slice(i, i + safeConcurrency);
        const promises = batch.map(async (filename) => {
          const photoId = await this.findPhotoByFilename(filename);
          return { filename, photoId };
        });

        const batchResults = await Promise.all(promises);

        for (const { filename, photoId } of batchResults) {
          processLookup(filename, photoId);
        }

        if (onProgress) {
          onProgress(results.size, uniqueFilenames.length);
        }

        // Delay between batches to avoid rate limiting
        await this.delay(100);
      }
    }

    return results;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
