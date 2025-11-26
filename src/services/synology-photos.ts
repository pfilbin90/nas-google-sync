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
        // Find the volume containing photos
        const photoVolume = volumes.find((v: any) =>
          this.config.photoLibraryPath.startsWith(`/${v.name}`) ||
          v.name === 'volume1'
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

    let offset = 0;
    let totalCount = 0;
    const limit = 100;

    do {
      const response = await this.fetchPhotos(offset, limit);

      if (!response.success || !response.data?.list) {
        break;
      }

      const photos = response.data.list;
      if (photos.length === 0) break;

      for (const photo of photos) {
        await this.processPhoto(photo);
        totalCount++;
      }

      if (onProgress) {
        onProgress(totalCount);
      }

      offset += limit;

      // Rate limiting
      await this.delay(50);
    } while (true);

    logger.info(`Synology scan complete for ${this.config.name}: ${totalCount} photos found`);
    return totalCount;
  }

  private async fetchPhotos(offset: number, limit: number): Promise<SynologyApiResponse<{ list: SynologyPhoto[] }>> {
    // Try Synology Photos API (DSM 7+)
    try {
      const response = await this.client.get<SynologyApiResponse<{ list: SynologyPhoto[] }>>(
        '/webapi/entry.cgi',
        {
          params: {
            api: 'SYNO.Foto.Browse.Item',
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
      logger.debug(`Synology Photos API failed, trying Photo Station API: ${error}`);
    }

    // Fallback to Photo Station API (DSM 6)
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
      return { success: false };
    }
  }

  private async processPhoto(photo: SynologyPhoto): Promise<void> {
    const hash = this.generateContentHash(photo);

    const photoRecord: PhotoRecord = {
      id: `synology-${this.config.name}-${photo.id}`,
      source: 'synology',
      accountName: this.config.name,
      filename: photo.filename,
      mimeType: this.getMimeType(photo.filename, photo.type),
      creationTime: new Date(photo.time * 1000).toISOString(),
      width: photo.additional?.resolution?.width,
      height: photo.additional?.resolution?.height,
      fileSize: photo.filesize,
      hash,
      synologyPath: `${this.config.photoLibraryPath}/${photo.filename}`,
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

    const folder = destinationFolder || this.config.photoLibraryPath;

    try {
      // Create a FormData-like object for upload
      const FormData = (await import('form-data')).default;
      const form = new FormData();

      form.append('api', 'SYNO.Foto.Upload.Item');
      form.append('version', '1');
      form.append('method', 'upload');
      form.append('_sid', this.sid);
      form.append('filename', filename);
      form.append('folder_id', '0'); // Root folder or specify target
      form.append('file', buffer, { filename });

      const response = await this.client.post<SynologyApiResponse>(
        '/webapi/entry.cgi',
        form,
        {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
