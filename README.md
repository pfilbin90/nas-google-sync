# NAS-Google-Sync

Backup Google Photos to Synology NAS and free up Google storage space.

## Why This Tool Exists

Google deprecated their Photos Library API in March 2025, making it impossible for third-party apps to read your photo library directly. This tool works around that limitation by:

1. Importing photos from **Google Takeout** exports
2. Detecting duplicates using SHA-256 file hashes
3. Uploading new photos to **Synology Photos**
4. Generating reports of what's safely backed up and can be deleted from Google

## Features

- **Multi-account support** - Handle separate accounts for family members
- **Intelligent duplicate detection** - SHA-256 hash comparison between Google Takeout and Synology
- **Account pairing** - Route each Google account to its own Synology user (e.g., user1's Google → user1's Synology)
- **Date-based export** - Get date ranges of backed-up photos for easy deletion from Google
- **Dry-run mode** - Preview what will be synced before committing

## Prerequisites

- Node.js 18+
- Synology NAS running DSM 7 with Synology Photos installed
- Google account(s) with Google Photos

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/nas-google-sync.git
cd nas-google-sync
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and configure:

```env
# Synology NAS connection
SYNOLOGY_HOST=192.168.1.100
SYNOLOGY_PORT=5000
SYNOLOGY_SECURE=false

# Synology accounts (comma-separated names)
SYNOLOGY_ACCOUNTS=user1,user2

# Per-account Synology credentials
SYNOLOGY_user1_USERNAME=user1
SYNOLOGY_user1_PASSWORD=your_password
SYNOLOGY_user1_PHOTO_PATH=/homes/user1/Photos

SYNOLOGY_user2_USERNAME=user2
SYNOLOGY_user2_PASSWORD=your_password
SYNOLOGY_user2_PHOTO_PATH=/homes/user2/Photos

# Google account names (for organizing imports)
GOOGLE_ACCOUNTS=user1_google,user2_google

# Account pairing (which Google account syncs to which Synology account)
PAIRING_1_GOOGLE=user1_google
PAIRING_1_SYNOLOGY=user1

PAIRING_2_GOOGLE=user2_google
PAIRING_2_SYNOLOGY=user2

# Safety settings
DRY_RUN=false
```

**Important**: Synology users must be in the Administrators group for DSM 7 API access.

---

## Complete Workflow

Run `npm run start -- workflow` for an interactive guide, or follow these steps:

### Step 1: Export from Google Takeout (Manual - Recurring)

1. Go to [takeout.google.com](https://takeout.google.com)
2. Click **"Deselect all"**
3. Scroll down and select only **"Google Photos"**
4. Click **"Next step"**
5. Configure delivery:
   - **Frequency**: "Export every 2 months for 1 year" *(recommended)*
   - **File type**: ZIP
   - **File size**: 2GB *(will create multiple files for large libraries)*
   - **Destination**: "Add to Drive" or "Send download link via email"
6. Click **"Create export"**
7. Wait for email notification (can take hours/days for large libraries)
8. Download all zip files

**Repeat for each Google account.**

### Step 2: Extract the Takeout Files

If you received multiple zip files, extract them all to the same folder:

**Windows PowerShell:**
```powershell
# Create destination folder
New-Item -ItemType Directory -Path "C:\Takeout\user1" -Force

# Extract all zips to the same folder (they'll merge)
Get-ChildItem "C:\Downloads\takeout-*.zip" | ForEach-Object {
    Expand-Archive -Path $_.FullName -DestinationPath "C:\Takeout\user1" -Force
}
```

**Or** manually extract each zip to the same destination folder.

### Step 3: Scan Your Synology NAS

Index existing photos on your NAS for duplicate detection:

```bash
npm run start -- scan
```

### Step 4: Import the Google Takeout

```bash
# Import user1's photos
npm run start -- import "C:\Takeout\user1" --account user1_google

# Import user2's photos
npm run start -- import "C:\Takeout\user2" --account user2_google
```

The import will show:
- Total photos scanned
- New photos (not already on Synology)
- Duplicates already on Synology
- Duplicates within the takeout itself

### Step 5: Sync to Synology

**Preview first (recommended):**
```bash
npm run start -- sync --account user1_google --dry-run
```

**Actually upload:**
```bash
# Upload 100 photos at a time (default)
npm run start -- sync --account user1_google

# Upload more at once
npm run start -- sync --account user1_google --count 500
```

### Step 6: Export Backed-Up Photo List

See what's safe to delete from Google:

```bash
# Show date ranges (best for Google Photos Toolkit)
npm run start -- export --format dates

# Export full list to CSV
npm run start -- export -o backed-up.csv

# Filter by account
npm run start -- export --account user1_google --format dates
```

### Step 7: Delete from Google Photos

**Google's API does not support deletion.** Use one of these methods:

#### Option A: Google Photos Toolkit (Recommended)

1. Install [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Install [Google Photos Toolkit](https://github.com/xob0t/Google-Photos-Toolkit/releases)
3. Go to [photos.google.com](https://photos.google.com)
4. Click the **GPTK icon** in the toolbar
5. Filter by the date range from Step 6
6. Click **"Move to trash"**
7. Go to Trash and click **"Empty trash"**

#### Option B: Manual Deletion

1. Go to [photos.google.com](https://photos.google.com)
2. Sort by date, select photos in the backed-up date range
3. Delete and empty trash

---

## Commands Reference

| Command | Description |
|---------|-------------|
| `scan` | Scan Synology NAS to index existing photos |
| `import <path>` | Import photos from Google Takeout folder |
| `sync` | Upload imported photos to Synology |
| `status` | Show storage stats and sync progress |
| `analyze` | Generate detailed analysis report |
| `export` | Export list of backed-up photos (for deletion) |
| `duplicates` | Find and list duplicate photos |
| `workflow` | Show complete workflow guide |

### Command Options

```bash
# Import options
npm run start -- import <path> --account <name>    # Specify account
npm run start -- import <path> --zip               # Extract zip first

# Sync options
npm run start -- sync --account <name>             # Specific account
npm run start -- sync --count 500                  # Number of photos
npm run start -- sync --dry-run                    # Preview only

# Export options
npm run start -- export --format dates             # Date ranges
npm run start -- export --format csv               # CSV file
npm run start -- export --format json              # JSON file
npm run start -- export --account <name>           # Filter by account
npm run start -- export -o filename.csv            # Custom filename
```

---

## Ongoing Maintenance

Once set up, your recurring workflow is:

1. **Every 2 months** (when Google Takeout emails arrive):
   - Download the new export zip files
   - Extract to a folder
   - Run `import` then `sync`
   - Run `export --format dates`
   - Delete backed-up photos from Google using GPTK

2. **Periodically**:
   - Run `status` to check sync progress
   - Run `analyze` for a full report

---

## Troubleshooting

### Synology Authentication Failed
- Ensure the user is in the **Administrators group** (DSM 7 requirement)
- Verify username/password in `.env`
- Check that Synology Photos is installed and enabled

### Import Shows 0 New Photos
- Photos may already exist on Synology (matched by hash)
- Check that the takeout folder contains a "Google Photos" subfolder
- Verify the path is correct

### Sync Fails with Permission Error
- Check `PHOTO_PATH` is correct for the user's Personal Space
- Ensure the Synology user has write access to that path

### Multiple Zip Files
- Extract all zips to the **same destination folder** before importing
- The "Google Photos" folders will merge automatically

---

## Data Storage

| Location | Purpose |
|----------|---------|
| `./data/photos.db` | SQLite database with photo index and sync status |
| `./logs/` | Application logs |

---

## Limitations

- **Google Takeout is manual** - No API exists to automate it (use scheduled exports)
- **Deletion is manual** - Google's API doesn't support photo deletion
- **Hash-based matching** - Renamed files are correctly detected as duplicates
- **Processing time** - Large libraries (10,000+ photos) may take hours

---

## Architecture

```
src/
├── index.ts                 # CLI entry point
├── config.ts                # Configuration management
├── models/
│   └── database.ts          # SQLite photo index
├── services/
│   ├── google-takeout.ts    # Takeout folder parser
│   ├── synology-photos.ts   # Synology Photos API
│   └── sync-service.ts      # Orchestration logic
└── utils/
    └── logger.ts            # Winston logger
```

---

## License

MIT
