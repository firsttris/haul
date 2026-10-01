# Extraction

When all downloads of a package are done, Haul extracts its archives into the package folder with
`unrar` and `7z` (both are in the image), with progress in percent.

- [What is extracted](#what-is-extracted)
- [Incomplete archives](#incomplete-archives)
- [Archive passwords](#archive-passwords)
- [Settings](#settings)
- [The Done view](#the-done-view)
- [Troubleshooting](#troubleshooting)

## What is extracted

RAR (also RAR5 and multi-part `.partN.rar` or `.rar`/`.r00`), 7z, ZIP and split archives (`.7z.001`,
`.zip.001`). Each package extracts only the archives it downloaded itself, so packages that share a
folder do not get in each other's way.

For RAR, Haul prefers `unrar`: the RAR module of some 7-Zip versions crashes on certain archives. It
finds `7zz`, `7z`, `7za`, `unrar` and `unar` by itself; which ones it found is shown under
**Settings → Folders**.

## Incomplete archives

Haul does not extract an archive that is not complete:

- a part is still downloading, even in another package of the same folder: the automatic start waits
  for it;
- a part is missing from the numbering (`part01`, `part03`);
- the last RAR part there says in its end block that another part follows, so a lone `part01.rar` of a
  larger set counts as incomplete.

The package then shows which part is missing, for example
"archive incomplete, missing: Movie.part02.rar", instead of trying passwords on it.

## Archive passwords

For a protected archive, Haul tries in this order:

1. no password,
2. the package's password (link grabber or Click'n'Load),
3. the archive's name,
4. the list under **Settings → Archive passwords**.

If none fits, Haul asks in the banner at the top, up to three times. This can be turned off. The
password that opened an archive moves to the top of the list, so it is tried first next time.

## Settings

| Setting | Default |
|---|---|
| Extract finished packages automatically | on |
| Delete archives after successful extraction | off |
| Remove the downloads from the list after successful extraction | off |
| Ask for the archive password when none fits | on |

Removing the downloads takes only the extracted archive parts out of the list; other files of the
package, such as an `.nfo`, stay. An emptied package disappears. The files on disk stay either way.

## The Done view

**Done** shows the done folder as it is on disk, with each package's state: extracted, archives left,
error, or not from Haul. Select entries with the checkboxes, then:

- **Extract**: any part of a set extracts the whole set, into the same folder;
- move to another folder, create a folder;
- delete the archives, or delete the entries.

## Troubleshooting

When extraction fails, the message names every extractor that was tried, with its exit code or signal
and its error lines. The full output is in the server log.
