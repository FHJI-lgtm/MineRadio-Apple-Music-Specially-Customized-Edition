# ID correspondence 20260925-190532

known Apple Music song ids: 1603171530, 535824738, 1193701392

## P1: lookup(known id) across storefronts

| song | id fed in | storefront | returned trackId | same id | track | artist |
|---|---|---|---|---|---|---|
| A-realname | 1603171530 | (default) | 1603171530 | True | How Do I Make You Love Me? | The Weeknd |
| A-realname | 1603171530 | us | 1603171530 | True | How Do I Make You Love Me? | The Weeknd |
| A-realname | 1603171530 | cn | 1603171530 | True | How Do I Make You Love Me? | Abel Tesfaye |
| A-realname | 1603171530 | tw | 1603171530 | True | How Do I Make You Love Me? | Abel Tesfaye |
| B-cn | 535824738 | (default) |  | False |  |  |
| B-cn | 535824738 | us |  | False |  |  |
| B-cn | 535824738 | cn | 535824738 | True | 晴天 | 周杰伦 |
| B-cn | 535824738 | tw | 535824738 | True | 晴天 | 周杰倫 |
| C-en | 1193701392 | (default) | 1193701392 | True | Shape of You | Ed Sheeran |
| C-en | 1193701392 | us | 1193701392 | True | Shape of You | Ed Sheeran |
| C-en | 1193701392 | cn | 1193701392 | True | Shape of You | Ed Sheeran |
| C-en | 1193701392 | tw | 1193701392 | True | Shape of You | Ed Sheeran |

## P2: search(title, artist) -> id  vs the known Apple Music id

| song | via | resolved id | same as known | matched artist | matched album | runner-up |
|---|---|---|---|---|---|---|
| A-realname | as-defined |  | False |  |  |  /  |
| A-realname | title-only | 1630220632 | False | The Weeknd | Dawn FM (Alternate World) | The Weeknd / How Do I Make You Love Me? |
| A-realname | with-catalog-artist-alias | 1641597510 | False | The Weeknd | Dawn FM (Alternate World) | The Weeknd / How Do I Make You Love Me? |
| B-cn | as-defined |  | False |  |  |  /  |
| B-cn | title-only | 1621039848 | False | 罗可 | 想安静的时候 - EP | 李嘉桐 / 晴天 |
| B-cn | with-catalog-artist-alias |  | False |  |  |  /  |
| C-en | as-defined | 1193700767 | False | Ed Sheeran | ÷ | Ed Sheeran / Shape of You |
| C-en | title-only | 1804602703 | False | Phonotic | Shape of You - Single | Secrets / Shape of You |
| C-en | with-catalog-artist-alias | 1193700767 | False | Ed Sheeran | ÷ | Ed Sheeran / Shape of You |

## P3: URL forms for the same id (navigation + UIA row check, nothing clicked)

| song | url form | navigated | target row found | row name |
|---|---|---|---|---|
| A-realname | verified-album-form | True | True | 音轨 3 How Do I Make You Love Me? 3 分钟，34 秒钟 |
| A-realname | canonical-song-form | False | True | 音轨 3 How Do I Make You Love Me? 3 分钟，34 秒钟 |
| A-realname | different-slug | False | True | 音轨 3 How Do I Make You Love Me? 3 分钟，34 秒钟 |