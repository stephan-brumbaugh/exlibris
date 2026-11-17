# Ex Libris

A self-hosted personal library that looks like real bookshelves. It has no connection to ShelfHaven or any other upstream project.

- **Public side, with no sign-in:** bookcases with spines or covers, shelves that keep going down the page, a details card for each book, downloads for e-books and PDFs, and **Listen** buttons that open Audiobookshelf, Plex or Audible.
- **Admin side at `/admin`, protected by a password:** upload books or scan folders, edit details, fetch covers, drag books around a shelf, add pictures and animated GIFs, and change how each bookcase looks.
- **Your physical shelves:** import the *Bookcase Database* spreadsheet to get one bookcase per case letter (A, B, C…), a labelled shelf for every shelf code (A3, B1…), and every book in its left-to-right order.

One container. SQLite database. Your book files stay where they are.

---

## Install on TrueNAS SCALE

GitHub builds the app automatically (see `.github/workflows/docker.yml`) and publishes it as `ghcr.io/stephan-brumbaugh/exlibris:latest`. Nothing needs to be copied onto the NAS.

1. **Create a dataset** for the app's data, for example `/mnt/HomeLab/exlibris/data`. Give the TrueNAS `apps` user (568) write access to it, and read access to your e-book folder.
2. **Install the app.** Go to **Apps → Discover Apps → ⋮ → Install via YAML** and paste `compose.yml`. Before saving:
   - point the `/library` volume at your e-book folder
   - change `ADMIN_PASSWORD`
3. **Sign in.** Open `http://<truenas-ip>:13100/admin` and use that password. Then change it in **Settings**.

### Updating

Push changes to `main` and wait for the **Build image** action to finish (about 2–3 minutes). Then in TrueNAS go to **Apps → exlibris → Update**, or stop and start the app; it always pulls the latest image. Database changes are applied automatically when the app starts.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | – | Sets the admin password at startup. Leave it out to choose one on first visit. |
| `LIBRARY_DIRS` | `/library` | Folders to scan, separated by commas. Scanning only reads them. |
| `SCAN_ON_START` | `true` | Scan the library folders when the app starts. |
| `SCAN_INTERVAL_MINUTES` | `0` | Rescan on a timer (`0` = off). |
| `MAX_UPLOAD_MB` | `1024` | Size limit for each uploaded file. |
| `SECURE_COOKIES` | `false` | Set to `true` when the app is behind HTTPS. |
| `PORT` / `DATA_DIR` | `3000` / `/data` | Usually left alone. |

---

## Moving over from the ShelfHaven setup

The old stack kept e-books inside MinIO. Recent MinIO versions don't store objects on disk as plain files, so copy them out once:

```sh
mkdir -p /mnt/HomeLab/Media/Books/from-shelfhaven
docker run --rm --network host -v /mnt/HomeLab/Media/Books/from-shelfhaven:/out minio/mc \
  sh -c 'mc alias set old http://127.0.0.1:9000 minioadmin "<MINIO_SECRET_KEY>" && mc mirror old/ebooks /out'
```

Next, point `LIBRARY_DIRS` (the `/library` volume) at that folder and press **Scan now**. Once you're happy with Ex Libris, stop and remove the old app, its MySQL, MinIO and Calibre containers, and the `/mnt/HomeLab/shelfhaven` datasets.

> The old compose file contained live passwords and secrets. If any of them were reused anywhere else, change them there too.

## Recreating your home shelves

1. In Google Sheets, open *Bookcase Database* and choose **File → Download → Microsoft Excel (.xlsx)**.
2. In the admin, go to **Import** and drop the file in.
3. Pick the **Master Database** sheet, which is where the books are now. Or pick **Sort** and tick *Use the planned layout* to get the reorganised arrangement; *Donate* and *Discard* rows are skipped.
4. Click **Import**. You'll get:
   - *Bookcase A* through *Bookcase I* and *Loose Books*, with each case's room taken from the **Case Identifier** sheet
   - a smart shelf called *The Whole House*
5. On the Dashboard, run **Fetch missing covers & details**. It looks up each book on Open Library and Google Books, one at a time, and only fills in empty fields. Spines are coloured from each cover's left edge. Until a book has a cover, every book in the same series shares a cloth colour.

You can re-import whenever the spreadsheet changes. Books are matched to their earlier rows, so positions update instead of duplicating. If a physical book has the same title and author as an e-book, the two become one entry: it shows where the book sits at home **and** offers the download.

## Audiobooks

- **Audiobookshelf:** go to **Audio links**, enter the server address, an API token and (optionally) the library id, then click **Save & read catalogue**.
  - Exact title-and-author matches are pre-selected. Similar titles are suggested but never applied unless you choose them.
  - Unmatched titles can be added as audiobook-only books.
  - Nothing is ever deleted.
- **Plex:** same flow. Use the server address and your `X-Plex-Token`. Each album in a Music library counts as one title.
- **Audible:** Audible has no API for reading your library. Add links on a book's edit page (it has a *Search Audible* helper), or add an `Audible URL` column to a spreadsheet import.

## Shelf builder tips

- **Selecting:** click a book to select it. Shift-click selects a range; Ctrl/⌘-click adds to the selection. Dragging a selected book moves the whole selection with it.
- **Keyboard:** **S** = spine out, **C** = cover out, **Enter** = start a new shelf after the selection, **Delete** = remove from the shelf.
- **Decorations:** upload them on the **Decorations** page (transparent PNGs and animated GIFs look best), then click one in the builder to place it.
- **Look:** the **Look** tab has ten bookcase styles. You can also change colours, shelf height, lighting and labels, put a picture behind the books, and set wallpaper around the case.
- **Smart shelves** keep themselves up to date. Examples: every EPUB, everything with an audiobook link, or one author grouped by series. Use **Convert to hand-arranged** to freeze one and arrange it yourself.

## Development

```sh
npm install
ADMIN_PASSWORD=devpass DATA_DIR=./data LIBRARY_DIRS=./books npm run dev
npm test
```

**Stack:**

- Node 22, Express 5, better-sqlite3 and sharp
- `poppler-utils` for PDF covers
- SortableJS for dragging
- No front-end build step: plain ES modules in `public/js` (the public site) and `admin/` (the admin pages)
