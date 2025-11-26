import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface GoogleAccountConfig {
  name: string;
  // Note: credentialsPath and tokenPath are no longer needed
  // since we use Google Takeout instead of the API
}

export interface SynologyAccountConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  photoLibraryPath: string;
  useSsl: boolean;
}

export interface AccountPairing {
  googleAccountName: string;
  synologyAccountName: string;
}

export interface Config {
  googleAccounts: GoogleAccountConfig[];
  synologyAccounts: SynologyAccountConfig[];
  accountPairings: AccountPairing[];
  storageThresholdPercent: number;
  databasePath: string;
  dryRun: boolean;
  logLevel: string;
}

export function loadConfig(): Config {
  // Parse Synology accounts from SYNOLOGY_ACCOUNTS env var
  // Format: SYNOLOGY_ACCOUNTS=pete,becca,shared_space
  // Then each account needs: SYNOLOGY_{name}_USERNAME, SYNOLOGY_{name}_PASSWORD, SYNOLOGY_{name}_PHOTO_PATH
  const synologyAccounts: SynologyAccountConfig[] = [];

  const synologyAccountNames = (process.env.SYNOLOGY_ACCOUNTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const globalHost = process.env.SYNOLOGY_HOST || 'localhost';
  const globalPort = parseInt(process.env.SYNOLOGY_PORT || '5000', 10);
  const globalUseSsl = process.env.SYNOLOGY_SECURE === 'true';

  for (const accountName of synologyAccountNames) {
    synologyAccounts.push({
      name: accountName,
      host: process.env[`SYNOLOGY_${accountName}_HOST`] || globalHost,
      port: parseInt(process.env[`SYNOLOGY_${accountName}_PORT`] || String(globalPort), 10),
      username: process.env[`SYNOLOGY_${accountName}_USERNAME`] || '',
      password: process.env[`SYNOLOGY_${accountName}_PASSWORD`] || '',
      photoLibraryPath: process.env[`SYNOLOGY_${accountName}_PHOTO_PATH`] || '/photo',
      useSsl: process.env[`SYNOLOGY_${accountName}_SECURE`] === 'true' || globalUseSsl,
    });
  }

  // Fallback: support legacy numbered account format (SYNOLOGY_ACCOUNT_1_NAME, etc.)
  if (synologyAccounts.length === 0) {
    for (let i = 1; i <= 3; i++) {
      const name = process.env[`SYNOLOGY_ACCOUNT_${i}_NAME`];
      if (name) {
        synologyAccounts.push({
          name,
          host: process.env[`SYNOLOGY_ACCOUNT_${i}_HOST`] || globalHost,
          port: parseInt(process.env[`SYNOLOGY_ACCOUNT_${i}_PORT`] || String(globalPort), 10),
          username: process.env[`SYNOLOGY_ACCOUNT_${i}_USERNAME`] || '',
          password: process.env[`SYNOLOGY_ACCOUNT_${i}_PASSWORD`] || '',
          photoLibraryPath: process.env[`SYNOLOGY_ACCOUNT_${i}_PHOTO_PATH`] || '/photo',
          useSsl: process.env[`SYNOLOGY_ACCOUNT_${i}_USE_SSL`] === 'true' || globalUseSsl,
        });
      }
    }
  }

  // Final fallback: single legacy account
  if (synologyAccounts.length === 0 && process.env.SYNOLOGY_HOST) {
    synologyAccounts.push({
      name: 'NAS',
      host: process.env.SYNOLOGY_HOST,
      port: parseInt(process.env.SYNOLOGY_PORT || '5000', 10),
      username: process.env.SYNOLOGY_USERNAME || '',
      password: process.env.SYNOLOGY_PASSWORD || '',
      photoLibraryPath: process.env.SYNOLOGY_PHOTO_LIBRARY_PATH || '/photo',
      useSsl: process.env.SYNOLOGY_USE_SSL === 'true',
    });
  }

  // Parse Google account names from GOOGLE_ACCOUNTS env var
  // These are just labels for organizing imports - no API credentials needed
  const googleAccountNames = (process.env.GOOGLE_ACCOUNTS || 'account_1,account_2')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const googleAccounts: GoogleAccountConfig[] = googleAccountNames.map(name => ({ name }));

  // Build account pairings (Google account -> Synology account)
  const accountPairings: AccountPairing[] = [];

  if (process.env.PAIRING_1_GOOGLE && process.env.PAIRING_1_SYNOLOGY) {
    accountPairings.push({
      googleAccountName: process.env.PAIRING_1_GOOGLE,
      synologyAccountName: process.env.PAIRING_1_SYNOLOGY,
    });
  }

  if (process.env.PAIRING_2_GOOGLE && process.env.PAIRING_2_SYNOLOGY) {
    accountPairings.push({
      googleAccountName: process.env.PAIRING_2_GOOGLE,
      synologyAccountName: process.env.PAIRING_2_SYNOLOGY,
    });
  }

  // Auto-pair if names match and no explicit pairings
  if (accountPairings.length === 0) {
    for (const google of googleAccounts) {
      const matchingSynology = synologyAccounts.find(s => s.name === google.name);
      if (matchingSynology) {
        accountPairings.push({
          googleAccountName: google.name,
          synologyAccountName: matchingSynology.name,
        });
      }
    }
  }

  return {
    googleAccounts,
    synologyAccounts,
    accountPairings,
    storageThresholdPercent: parseInt(process.env.STORAGE_THRESHOLD_PERCENT || '80', 10),
    databasePath: process.env.DATABASE_PATH || './data/photos.db',
    dryRun: process.env.DRY_RUN === 'true',
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}

// Helper to get the paired Synology account for a Google account
export function getPairedSynologyAccount(config: Config, googleAccountName: string): SynologyAccountConfig | undefined {
  const pairing = config.accountPairings.find(p => p.googleAccountName === googleAccountName);
  if (!pairing) return undefined;
  return config.synologyAccounts.find(s => s.name === pairing.synologyAccountName);
}
