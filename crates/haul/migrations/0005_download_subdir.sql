-- Folder inside the package folder the file goes to (`CD1/Extras`), as the crawled folder has
-- it (Google Drive subfolders); NULL for the package folder itself.
ALTER TABLE downloads ADD COLUMN subdir TEXT;
