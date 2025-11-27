#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';
import { SyncService, AnalysisReport } from './services/sync-service.js';
import { extractTakeoutZip } from './services/google-takeout.js';
import { getPhotoStats, closeDatabase, getDatabase } from './models/database.js';

const program = new Command();

program
  .name('nas-google-sync')
  .description('Sync Google Takeout photos to Synology NAS with intelligent deduplication')
  .version('1.0.0');

program
  .command('scan')
  .description('Scan Synology NAS to index existing photos')
  .action(async () => {
    const service = new SyncService();

    try {
      await service.authenticateAll();
      logger.info('Scanning Synology Photos...');

      await service.scanSynology((source, count) => {
        process.stdout.write(`\r${source}: ${count} photos scanned...`);
      });

      console.log('\n');
      const stats = getPhotoStats();
      console.log('Scan Results:');
      console.log(`  Synology Photos: ${stats.totalSynology}`);
      console.log(`  Google Takeout imports: ${stats.totalGoogle}`);
      console.log(`  Already backed up: ${stats.backedUp}`);
      console.log(`  Duplicates found: ${stats.duplicates}`);
    } catch (error) {
      logger.error(`Scan failed: ${error}`);
      process.exit(1);
    } finally {
      await service.cleanup();
      closeDatabase();
    }
  });

program
  .command('import')
  .description('Import photos from a Google Takeout export folder')
  .argument('<path>', 'Path to the extracted Google Takeout folder (containing "Google Photos" subfolder)')
  .option('-a, --account <name>', 'Google account name (e.g., pete_account)', 'default')
  .option('--zip', 'Path is a zip file - extract it first')
  .action(async (takeoutPath: string, options) => {
    const service = new SyncService();
    const config = loadConfig();

    try {
      let importPath = takeoutPath;

      // If it's a zip file, extract it first
      if (options.zip) {
        const destPath = takeoutPath.replace(/\.zip$/i, '');
        console.log(`Extracting ${takeoutPath}...`);
        importPath = await extractTakeoutZip(takeoutPath, destPath);
      }

      // Try to find the Google Photos subfolder
      const fs = await import('fs');
      const path = await import('path');

      let photosPath = importPath;
      const googlePhotosSubfolder = path.join(importPath, 'Google Photos');
      const takeoutSubfolder = path.join(importPath, 'Takeout', 'Google Photos');

      if (fs.existsSync(googlePhotosSubfolder)) {
        photosPath = googlePhotosSubfolder;
      } else if (fs.existsSync(takeoutSubfolder)) {
        photosPath = takeoutSubfolder;
      }

      console.log(`\nImporting from: ${photosPath}`);
      console.log(`Account: ${options.account}\n`);

      const result = await service.importFromTakeout(
        photosPath,
        options.account,
        (count) => {
          process.stdout.write(`\rScanned ${count} photos...`);
        }
      );

      console.log('\n');
      console.log('========== IMPORT RESULTS ==========');
      console.log(`  Account: ${result.accountName}`);
      console.log(`  Total scanned: ${result.totalScanned}`);
      console.log(`  New photos: ${result.newPhotos}`);
      console.log(`  Already on Synology: ${result.duplicatesInSynology}`);
      console.log(`  Duplicates in takeout: ${result.duplicatesInTakeout}`);

      if (result.errors.length > 0) {
        console.log(`  Errors: ${result.errors.length}`);
        if (result.errors.length <= 5) {
          for (const err of result.errors) {
            console.log(`    - ${err}`);
          }
        }
      }
      console.log('====================================\n');

      if (result.newPhotos > 0) {
        console.log(`Run 'npm run sync -- --account ${options.account}' to upload to Synology.`);
      }
    } catch (error) {
      logger.error(`Import failed: ${error}`);
      process.exit(1);
    } finally {
      closeDatabase();
    }
  });

program
  .command('analyze')
  .description('Analyze photos and generate a report')
  .option('-o, --output <file>', 'Output report to file')
  .action(async (options) => {
    const service = new SyncService();

    try {
      await service.authenticateAll();

      const report = await service.generateAnalysisReport();

      console.log('\n========== PHOTO ANALYSIS REPORT ==========\n');
      console.log(`Generated: ${report.timestamp}\n`);

      console.log('--- GOOGLE TAKEOUT IMPORTS ---');
      for (const account of report.googleAccounts) {
        console.log(`\n${account.name}:`);
        console.log(`  Total photos imported: ${account.totalPhotos}`);
        console.log(`  Backed up to NAS: ${account.photosBackedUp}`);
        console.log(`  Not yet synced: ${account.photosNotBackedUp}`);
        console.log(`  Syncs to: ${account.pairedWith ? `${account.pairedWith}'s Synology Photos` : '(not paired)'}`);
      }

      console.log('\n--- SYNOLOGY ACCOUNTS ---');
      for (const account of report.synologyAccounts) {
        console.log(`\n${account.name}'s Synology Photos:`);
        console.log(`  Total photos: ${account.totalPhotos}`);
        if (account.storageTotal > 0) {
          console.log(`  Storage: ${formatBytes(account.storageUsed)} / ${formatBytes(account.storageTotal)} (${account.percentUsed.toFixed(1)}%)`);
        }
      }

      console.log('\n--- DUPLICATES (cross-account detection) ---');
      console.log(`  Found: ${report.duplicates.length}`);
      if (report.duplicates.length > 0 && report.duplicates.length <= 10) {
        for (const dup of report.duplicates) {
          console.log(`  - ${dup.photo1.filename} (${dup.photo1.source}:${dup.photo1.account}) <-> ${dup.photo2.filename} (${dup.photo2.source}:${dup.photo2.account}) [${dup.matchType}]`);
        }
      } else if (report.duplicates.length > 10) {
        console.log(`  (showing first 10)`);
        for (const dup of report.duplicates.slice(0, 10)) {
          console.log(`  - ${dup.photo1.filename} (${dup.photo1.source}:${dup.photo1.account}) <-> ${dup.photo2.filename} (${dup.photo2.source}:${dup.photo2.account}) [${dup.matchType}]`);
        }
      }

      console.log('\n--- RECOMMENDATIONS ---');
      if (report.recommendations.length === 0) {
        console.log('  No immediate actions needed.');
      } else {
        for (const rec of report.recommendations) {
          console.log(`  • ${rec}`);
        }
      }

      if (options.output) {
        const fs = await import('fs');
        fs.writeFileSync(options.output, JSON.stringify(report, null, 2));
        console.log(`\nReport saved to: ${options.output}`);
      }

      console.log('\n==========================================\n');
    } catch (error) {
      logger.error(`Analysis failed: ${error}`);
      process.exit(1);
    } finally {
      await service.cleanup();
      closeDatabase();
    }
  });

program
  .command('sync')
  .description('Sync imported takeout photos to Synology NAS')
  .option('-a, --account <name>', 'Google account name to sync from')
  .option('-n, --count <number>', 'Number of photos to sync', '100')
  .option('--dry-run', 'Show what would be synced without actually syncing')
  .action(async (options) => {
    const service = new SyncService();
    const config = loadConfig();

    try {
      await service.authenticateAll();

      const accounts = options.account
        ? [options.account]
        : config.googleAccounts.map(a => a.name);

      for (const accountName of accounts) {
        console.log(`\nSyncing ${accountName} to Synology...`);

        const result = await service.syncToSynology(
          accountName,
          parseInt(options.count, 10),
          options.dryRun,
          (current, total, filename) => {
            process.stdout.write(`\r[${current}/${total}] ${filename}...`);
          }
        );

        console.log(`\n${accountName}: Synced ${result.synced}, Failed ${result.failed}, Skipped ${result.skipped}`);
      }
    } catch (error) {
      logger.error(`Sync failed: ${error}`);
      process.exit(1);
    } finally {
      await service.cleanup();
      closeDatabase();
    }
  });

program
  .command('status')
  .description('Show current storage status and quick stats')
  .action(async () => {
    const service = new SyncService();

    try {
      await service.authenticateAll();
      const quotas = await service.checkStorageQuotas();

      console.log('\n========== STORAGE STATUS ==========\n');

      if (quotas.size > 0) {
        console.log('--- SYNOLOGY STORAGE ---');
        for (const [source, quota] of quotas) {
          const bar = createProgressBar(quota.percentUsed, 30);
          console.log(`${source}:`);
          console.log(`  ${bar} ${quota.percentUsed.toFixed(1)}%`);
          console.log(`  ${formatBytes(quota.used)} / ${formatBytes(quota.total)}\n`);
        }
      }

      const stats = getPhotoStats();
      console.log('--- PHOTO INDEX STATS ---');
      console.log(`  Google Takeout imported: ${stats.totalGoogle}`);
      console.log(`  Synology Photos indexed: ${stats.totalSynology}`);
      console.log(`  Backed up to NAS: ${stats.backedUp}`);
      console.log(`  Pending sync: ${stats.totalGoogle - stats.backedUp}`);

      console.log('\n===================================\n');
    } catch (error) {
      logger.error(`Status check failed: ${error}`);
      process.exit(1);
    } finally {
      await service.cleanup();
      closeDatabase();
    }
  });

program
  .command('duplicates')
  .description('Find and list duplicate photos')
  .option('--removable', 'Only show duplicates that can be safely removed')
  .action(async (options) => {
    const service = new SyncService();

    try {
      if (options.removable) {
        const removable = await service.findPhotosToRemove();
        console.log(`\nFound ${removable.length} photos that can be safely removed from Google:\n`);

        for (const photo of removable.slice(0, 20)) {
          console.log(`  - ${photo.filename} (${photo.accountName}) - ${photo.creationTime}`);
        }

        if (removable.length > 20) {
          console.log(`  ... and ${removable.length - 20} more`);
        }
      } else {
        // Show all duplicates
        const report = await service.generateAnalysisReport();
        console.log(`\nFound ${report.duplicates.length} duplicate pairs:\n`);

        for (const dup of report.duplicates.slice(0, 20)) {
          console.log(`  ${dup.photo1.filename} (${dup.photo1.source}:${dup.photo1.account})`);
          console.log(`    ↔ ${dup.photo2.filename} (${dup.photo2.source}:${dup.photo2.account})`);
          console.log(`    Match type: ${dup.matchType}\n`);
        }

        if (report.duplicates.length > 20) {
          console.log(`  ... and ${report.duplicates.length - 20} more pairs`);
        }
      }
    } catch (error) {
      logger.error(`Duplicate check failed: ${error}`);
      process.exit(1);
    } finally {
      await service.cleanup();
      closeDatabase();
    }
  });

program
  .command('export')
  .description('Export list of backed-up photos (for deletion from Google Photos)')
  .option('-a, --account <name>', 'Filter by Google account name')
  .option('-o, --output <file>', 'Output to CSV file', 'backed-up-photos.csv')
  .option('--format <type>', 'Output format: csv, json, or dates', 'csv')
  .action(async (options) => {
    const service = new SyncService();
    const fs = await import('fs');

    try {
      const photos = service.getPhotosSafeToDelete(options.account);

      if (photos.length === 0) {
        console.log('\nNo backed-up photos found to export.');
        console.log('Run "import" and "sync" first to backup photos.\n');
        return;
      }

      // Sort by date (oldest first)
      photos.sort((a, b) => new Date(a.creationTime).getTime() - new Date(b.creationTime).getTime());

      if (options.format === 'dates') {
        // Output date ranges for use with Google Photos Toolkit
        const dates = photos.map(p => new Date(p.creationTime));
        const oldest = dates[0];
        const newest = dates[dates.length - 1];

        console.log('\n========== BACKED-UP PHOTOS DATE RANGE ==========\n');
        console.log(`  Total photos backed up: ${photos.length}`);
        console.log(`  Oldest: ${oldest.toLocaleDateString()} (${oldest.toISOString().split('T')[0]})`);
        console.log(`  Newest: ${newest.toLocaleDateString()} (${newest.toISOString().split('T')[0]})`);

        // Group by year-month
        const byMonth = new Map<string, number>();
        for (const photo of photos) {
          const d = new Date(photo.creationTime);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          byMonth.set(key, (byMonth.get(key) || 0) + 1);
        }

        console.log('\n  By Month:');
        for (const [month, count] of [...byMonth.entries()].sort()) {
          console.log(`    ${month}: ${count} photos`);
        }

        console.log('\n================================================');
        console.log('\nUse these dates with Google Photos Toolkit to filter');
        console.log('and delete photos that are safely backed up to your NAS.\n');

      } else if (options.format === 'json') {
        const output = photos.map(p => ({
          filename: p.filename,
          date: p.creationTime,
          account: p.accountName,
          size: p.fileSize,
        }));
        fs.writeFileSync(options.output.replace('.csv', '.json'), JSON.stringify(output, null, 2));
        console.log(`\nExported ${photos.length} photos to ${options.output.replace('.csv', '.json')}\n`);

      } else {
        // CSV format
        const header = 'filename,date,account,size_bytes\n';
        const rows = photos.map(p =>
          `"${p.filename}","${p.creationTime}","${p.accountName}",${p.fileSize}`
        ).join('\n');
        fs.writeFileSync(options.output, header + rows);
        console.log(`\nExported ${photos.length} photos to ${options.output}\n`);
      }

    } catch (error) {
      logger.error(`Export failed: ${error}`);
      process.exit(1);
    } finally {
      closeDatabase();
    }
  });

program
  .command('inspect')
  .description('Inspect photos to verify matching is working correctly')
  .option('--new', 'Show photos marked as NEW (not on Synology)')
  .option('--matched', 'Show photos that matched Synology')
  .option('--synology', 'Show sample Synology photos for comparison')
  .option('-n, --count <number>', 'Number of photos to show', '20')
  .option('--search <filename>', 'Search for a specific filename')
  .action(async (options) => {
    const db = getDatabase();
    const limit = parseInt(options.count, 10);

    try {
      if (options.search) {
        // Search for a specific filename in both sources
        const searchTerm = `%${options.search}%`;

        console.log(`\n========== SEARCH: "${options.search}" ==========\n`);

        const synologyMatches = db.prepare(`
          SELECT filename, creation_time, file_size, source
          FROM photos
          WHERE source = 'synology' AND filename LIKE ?
          LIMIT 20
        `).all(searchTerm) as any[];

        const googleMatches = db.prepare(`
          SELECT filename, creation_time, file_size, source
          FROM photos
          WHERE source = 'google' AND filename LIKE ?
          LIMIT 20
        `).all(searchTerm) as any[];

        console.log(`Synology matches (${synologyMatches.length}):`);
        for (const p of synologyMatches) {
          const date = p.creation_time ? p.creation_time.split('T')[0] : 'no-date';
          console.log(`  ${p.filename} | ${date} | ${p.file_size || '?'} bytes`);
        }

        console.log(`\nGoogle Takeout matches (${googleMatches.length}):`);
        for (const p of googleMatches) {
          const date = p.creation_time ? p.creation_time.split('T')[0] : 'no-date';
          console.log(`  ${p.filename} | ${date} | ${p.file_size || '?'} bytes`);
        }

        if (synologyMatches.length > 0 && googleMatches.length > 0) {
          console.log('\n⚠️  Found in BOTH - should have been marked as duplicate!');
          console.log('   Check if dates match (comparison uses YYYY-MM-DD only)');
        }

      } else if (options.matched) {
        // This would require tracking which photos matched during import
        // For now, show photos that exist in both (by filename)
        console.log('\n========== PHOTOS IN BOTH SYNOLOGY AND GOOGLE ==========\n');

        const matches = db.prepare(`
          SELECT
            g.filename,
            g.creation_time as google_date,
            s.creation_time as synology_date,
            g.file_size as google_size,
            s.file_size as synology_size
          FROM photos g
          JOIN photos s ON LOWER(g.filename) = LOWER(s.filename)
          WHERE g.source = 'google' AND s.source = 'synology'
          LIMIT ?
        `).all(limit) as any[];

        console.log(`Found ${matches.length} photos with same filename in both:\n`);
        for (const m of matches) {
          const gDate = m.google_date ? m.google_date.split('T')[0] : 'no-date';
          const sDate = m.synology_date ? m.synology_date.split('T')[0] : 'no-date';
          const dateMatch = gDate === sDate ? '✓' : '✗';
          console.log(`  ${m.filename}`);
          console.log(`    Google:   ${gDate} | ${m.google_size || '?'} bytes`);
          console.log(`    Synology: ${sDate} | ${m.synology_size || '?'} bytes`);
          console.log(`    Date match: ${dateMatch}\n`);
        }

      } else if (options.synology) {
        console.log('\n========== SYNOLOGY PHOTOS (sample) ==========\n');

        const photos = db.prepare(`
          SELECT filename, creation_time, file_size
          FROM photos
          WHERE source = 'synology'
          ORDER BY creation_time DESC
          LIMIT ?
        `).all(limit) as any[];

        for (const p of photos) {
          const date = p.creation_time ? p.creation_time.split('T')[0] : 'no-date';
          console.log(`  ${p.filename} | ${date} | ${p.file_size || '?'} bytes`);
        }

      } else {
        // Default: show NEW photos (from Google, not on Synology)
        console.log('\n========== NEW PHOTOS (not on Synology) ==========\n');

        const photos = db.prepare(`
          SELECT filename, creation_time, file_size
          FROM photos
          WHERE source = 'google' AND is_backed_up = 0
          ORDER BY creation_time ASC
          LIMIT ?
        `).all(limit) as any[];

        console.log(`Showing ${photos.length} oldest "new" photos:\n`);
        for (const p of photos) {
          const date = p.creation_time ? p.creation_time.split('T')[0] : 'no-date';
          console.log(`  ${p.filename} | ${date} | ${p.file_size || '?'} bytes`);
        }

        console.log('\nTip: Use --search <filename> to check if a specific photo exists on Synology');
      }

    } catch (error) {
      logger.error(`Inspect failed: ${error}`);
      process.exit(1);
    } finally {
      closeDatabase();
    }
  });

program
  .command('workflow')
  .description('Show the complete workflow for backing up and freeing Google storage')
  .action(() => {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║           NAS-GOOGLE-SYNC: Complete Workflow Guide                           ║
╚══════════════════════════════════════════════════════════════════════════════╝

This tool helps you backup Google Photos to your Synology NAS and identify
photos safe to delete from Google to free up storage.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1: EXPORT FROM GOOGLE (Manual - One Time Setup)
────────────────────────────────────────────────────
1. Go to https://takeout.google.com
2. Click "Deselect all", then select only "Google Photos"
3. Choose export frequency: "Export every 2 months for 1 year" (recommended)
4. Choose delivery method: "Add to Drive" or download link
5. Click "Create export" and wait for completion
6. Download/extract the zip files

TIP: Set up scheduled exports to automate this every 2 months.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 2: SCAN YOUR SYNOLOGY NAS
──────────────────────────────
  npm run start -- scan

This indexes all existing photos on your Synology to detect duplicates.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 3: IMPORT GOOGLE TAKEOUT
─────────────────────────────
  npm run start -- import "C:\\path\\to\\takeout" --account pete_account
  npm run start -- import "C:\\path\\to\\takeout" --account becca_account

This scans the takeout, calculates hashes, and identifies:
  - New photos (not on Synology)
  - Duplicates (already on Synology)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 4: SYNC TO SYNOLOGY
────────────────────────
  npm run start -- sync --account pete_account --dry-run  # Preview first
  npm run start -- sync --account pete_account            # Actually sync

This uploads new photos from the takeout to your Synology NAS.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 5: EXPORT BACKED-UP PHOTO LIST
───────────────────────────────────
  npm run start -- export --format dates     # Show date ranges
  npm run start -- export -o backed-up.csv   # Export full list

This shows you which photos are safely backed up and can be deleted from Google.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 6: DELETE FROM GOOGLE PHOTOS (Manual or Semi-Automated)
────────────────────────────────────────────────────────────
Google's API does NOT support deletion. Use one of these methods:

OPTION A: Google Photos Toolkit (Recommended)
  1. Install Tampermonkey: https://www.tampermonkey.net/
  2. Install script: https://github.com/xob0t/Google-Photos-Toolkit
  3. Go to photos.google.com
  4. Click GPTK icon, filter by date range from Step 5
  5. Select "Move to trash", then empty trash

OPTION B: Manual Deletion
  1. Go to photos.google.com
  2. Use the date ranges from Step 5
  3. Select photos, delete, empty trash

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OTHER USEFUL COMMANDS
─────────────────────
  npm run start -- status      # Quick storage stats
  npm run start -- analyze     # Full analysis report
  npm run start -- duplicates  # List duplicate photos

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  });

// Helper functions
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function createProgressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const color = percent >= 90 ? '\x1b[31m' : percent >= 80 ? '\x1b[33m' : '\x1b[32m';
  return `${color}[${'█'.repeat(filled)}${'░'.repeat(empty)}]\x1b[0m`;
}

program.parse();
