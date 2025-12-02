import { exiftool } from 'exiftool-vendored';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

export interface TagWriteResult {
  success: boolean;
  filePath: string;
  albumName: string;
  error?: string;
}

export interface TagWriteStats {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

/**
 * Service for writing album tags to photo metadata using exiftool.
 * This writes the album name to XMP:Subject and IPTC:Keywords fields,
 * which Synology Photos can read and use for organizing photos.
 */
export class TagWriterService {
  private dryRun: boolean;

  constructor(dryRun: boolean = false) {
    this.dryRun = dryRun;
  }

  /**
   * Write album name as a tag to a single photo
   */
  async writeAlbumTag(filePath: string, albumName: string): Promise<TagWriteResult> {
    const result: TagWriteResult = {
      success: false,
      filePath,
      albumName,
    };

    if (!albumName || albumName.trim() === '') {
      result.error = 'No album name provided';
      return result;
    }

    const ext = path.extname(filePath).toLowerCase();
    const supportedFormats = ['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.heic', '.heif'];

    if (!supportedFormats.includes(ext)) {
      result.error = `Unsupported format for tagging: ${ext}`;
      return result;
    }

    try {
      if (this.dryRun) {
        logger.info(`[DRY RUN] Would write tag "${albumName}" to ${filePath}`);
        result.success = true;
        return result;
      }

      // Read existing tags to preserve them - treat as hard failure if we can't read
      let existingTags: string[];
      try {
        existingTags = await this.readTags(filePath);
      } catch (readError) {
        result.error = `Cannot read existing tags: ${readError}`;
        logger.error(`Failed to read tags from ${filePath}: ${readError}`);
        return result;
      }

      const mergedTags = [...new Set([...existingTags, albumName])];

      // Write album name to multiple metadata fields for maximum compatibility:
      // - XMP:Subject - Used by many photo apps for keywords/tags
      // - IPTC:Keywords - Standard IPTC keyword field
      // - XMP:HierarchicalSubject - Hierarchical subject for albums
      await exiftool.write(filePath, {
        'Subject': mergedTags,
        'Keywords': mergedTags,
        'HierarchicalSubject': [`Album|${albumName}`],
      });

      // Clean up backup file created by exiftool
      const backupPath = `${filePath}_original`;
      try {
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath);
        }
      } catch (cleanupError) {
        // Don't fail the whole operation if cleanup fails
        logger.warn(`Could not clean up backup file ${backupPath}: ${cleanupError}`);
      }

      logger.debug(`Tagged ${path.basename(filePath)} with album: ${albumName}`);
      result.success = true;
    } catch (error: any) {
      // Better TOCTOU error handling
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        result.error = 'File not found or was deleted';
      } else {
        result.error = `Failed to write tag: ${error}`;
      }
      logger.warn(`Failed to write tag to ${filePath}: ${error}`);
    }

    return result;
  }

  /**
   * Write album tags to multiple photos
   */
  async writeAlbumTags(
    photos: Array<{ filePath: string; albumName: string }>,
    onProgress?: (current: number, total: number, filename: string) => void
  ): Promise<TagWriteStats> {
    const stats: TagWriteStats = {
      total: photos.length,
      success: 0,
      failed: 0,
      skipped: 0,
    };

    for (let i = 0; i < photos.length; i++) {
      const { filePath, albumName } = photos[i];

      if (onProgress) {
        onProgress(i + 1, photos.length, path.basename(filePath));
      }

      if (!albumName) {
        stats.skipped++;
        continue;
      }

      const result = await this.writeAlbumTag(filePath, albumName);

      if (result.success) {
        stats.success++;
      } else if (result.error?.includes('Unsupported format')) {
        stats.skipped++;
      } else {
        stats.failed++;
      }
    }

    return stats;
  }

  /**
   * Read existing tags from a photo
   */
  async readTags(filePath: string): Promise<string[]> {
    try {
      const tags = await exiftool.read(filePath);
      const keywords: string[] = [];

      if (tags.Subject) {
        if (Array.isArray(tags.Subject)) {
          keywords.push(...tags.Subject);
        } else {
          keywords.push(tags.Subject as string);
        }
      }

      if (tags.Keywords) {
        if (Array.isArray(tags.Keywords)) {
          keywords.push(...(tags.Keywords as string[]));
        } else {
          keywords.push(tags.Keywords as string);
        }
      }

      return [...new Set(keywords)]; // Remove duplicates
    } catch (error) {
      logger.error(`Failed to read tags from ${filePath}: ${error}`);
      throw new Error(`Cannot read existing tags: ${error}`);
    }
  }

  /**
   * Close the exiftool process
   */
  async close(): Promise<void> {
    try {
      await exiftool.end();
    } catch (error) {
      logger.warn(`Error closing exiftool: ${error}`);
    }
  }
}
