// ============================================================================
// MineRadioCoverResolver.exe
//   Apple Music (Microsoft Store) 本地 Artwork Resolver — 只读、一次性 CLI
//
// 用途: 当 SMTC 没有 Thumbnail 时, 从 Apple Music Windows 本地缓存解析
//       当前实际播放歌曲使用的 artwork (优先于第三方 iTunes Search API)。
//
// 链路:
//   %LOCALAPPDATA%\Packages\AppleInc.AppleMusicWin_*\AC\INetCache\*\*.json
//     (Apple Music Web API 响应: name/artistName/albumName/artwork.url)
//   -> 提取 mzstatic /v4/<xx>/<xx>/<xx>/<UUID>/ 片段
//   -> LocalCache\Local\Apple\AMPLibraryAgent\{Store_1,Radio_2}\artwork.sqlite
//        artwork_source(artwork_id, location)        片段 -> artwork_id
//        cache_items(artwork_id, size_kind, extension, image_hash, width, height, status)
//   -> artwork\<ARTWORK_ID>_sk1.jpeg  (800x800 baseline JPEG)
//   -> SOI/EOI + SHA-256 == image_hash 完整性校验
//
// 保证: 只读 (SQLITE_OPEN_READONLY + PRAGMA query_only), 不提权, 不联网,
//       不修改/删除/移动 Apple Music 任何文件, 无常驻进程/服务。
//
// 构建: desktop\native\build-cover-resolver.bat
// ============================================================================

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <bcrypt.h>

#include <sqlite3.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

// ---------------------------------------------------------------- 常量 / 退出码
enum ExitCode {
  EXIT_OK = 0,
  EXIT_NO_METADATA_JSON = 2,
  EXIT_NO_ARTWORK_MATCH = 3,
  EXIT_FILE_MISSING_OR_CORRUPT = 4,
  EXIT_TIMEOUT_OR_IO = 5,
};

static const int kDefaultTimeoutMs = 400;
static const size_t kMaxJsonFileBytes = 2u * 1024u * 1024u;    // 单文件上限
static const size_t kMaxJsonFilesScanned = 256;                 // 文件数量上限 (时间预算仍是主约束)
static const size_t kMaxTotalJsonBytes = 24u * 1024u * 1024u;   // 总扫描字节上限
static const int kCorruptRetryCount = 2;                       // 竞态重试次数
static const int kCorruptRetrySleepMs = 30;

// ---------------------------------------------------------------- 时间预算
struct Budget {
  ULONGLONG start = GetTickCount64();
  int limitMs = kDefaultTimeoutMs;
  ULONGLONG elapsed() const { return GetTickCount64() - start; }
  bool expired() const { return elapsed() > (ULONGLONG)limitMs; }
  int remaining() const { int e = (int)elapsed(); return e >= limitMs ? 0 : (limitMs - e); }
};

// ---------------------------------------------------------------- UTF-8 / 宽字符
static std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int need = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  if (need <= 0) return std::string();
  std::string out((size_t)need, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &out[0], need, nullptr, nullptr);
  return out;
}

static std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int need = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  if (need <= 0) return std::wstring();
  std::wstring out((size_t)need, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], need);
  return out;
}

static std::string ToLowerAscii(const std::string& s) {
  std::string out = s;
  for (char& c : out) if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
  return out;
}

static std::string Trim(const std::string& s) {
  size_t b = 0, e = s.size();
  while (b < e && (unsigned char)s[b] <= ' ') b++;
  while (e > b && (unsigned char)s[e - 1] <= ' ') e--;
  return s.substr(b, e - b);
}

// SMTC 的 Artist 常形如 "知更鸟, HOYO-MiX & Chevy — 唯有追赶风的方向 - Single"
// (Apple Music 把专辑并入 artist 字段)。规范化为首个分隔符之前的主体。
static std::string NormalizeArtist(const std::string& raw) {
  std::string s = Trim(raw);
  static const char* seps[] = { "\xE2\x80\x94", "\xE2\x80\x93", " - ", " \xE2\x80\xA2 " };  // — – " - " •
  size_t cut = std::string::npos;
  for (const char* sep : seps) {
    size_t p = s.find(sep);
    if (p != std::string::npos && (cut == std::string::npos || p < cut)) cut = p;
  }
  if (cut != std::string::npos && cut > 0) s = Trim(s.substr(0, cut));
  return s;
}

// ---------------------------------------------------------------- JSON 文本工具
static std::string JsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) { char buf[8]; sprintf(buf, "\\u%04x", c); out += buf; }
        else out += (char)c;
    }
  }
  return out;
}

// ---------------------------------------------------------------- SHA-256 (CNG)
static bool Sha256File(const std::wstring& path, std::string& hexUpper) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;

  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  bool ok = false;
  std::vector<unsigned char> objBuf, hashBuf;
  DWORD objLen = 0, hashLen = 0, cb = 0;

  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) goto done;
  if (BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, (PUCHAR)&objLen, sizeof(objLen), &cb, 0) != 0) goto done;
  if (BCryptGetProperty(alg, BCRYPT_HASH_LENGTH, (PUCHAR)&hashLen, sizeof(hashLen), &cb, 0) != 0) goto done;
  objBuf.resize(objLen);
  hashBuf.resize(hashLen);
  if (BCryptCreateHash(alg, &hash, objBuf.data(), objLen, nullptr, 0, 0) != 0) goto done;
  {
    std::vector<unsigned char> buf(64 * 1024);
    DWORD read = 0;
    while (ReadFile(h, buf.data(), (DWORD)buf.size(), &read, nullptr) && read > 0) {
      if (BCryptHashData(hash, buf.data(), read, 0) != 0) goto done;
    }
    if (GetLastError() != ERROR_SUCCESS && read == 0) { /* tolerate */ }
  }
  if (BCryptFinishHash(hash, hashBuf.data(), (DWORD)hashBuf.size(), 0) != 0) goto done;
  {
    static const char* kHex = "0123456789ABCDEF";
    hexUpper.clear();
    for (unsigned char b : hashBuf) { hexUpper += kHex[b >> 4]; hexUpper += kHex[b & 0x0F]; }
  }
  ok = true;

done:
  if (hash) BCryptDestroyHash(hash);
  if (alg) BCryptCloseAlgorithmProvider(alg, 0);
  CloseHandle(h);
  return ok;
}

// ---------------------------------------------------------------- JPEG 轻量校验
struct JpegInfo { bool soi = false; bool eoi = false; int width = 0; int height = 0; };

static bool InspectJpeg(const std::wstring& path, JpegInfo& info, unsigned long long& fileSize) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER sz{};
  if (!GetFileSizeEx(h, &sz) || sz.QuadPart <= 0) { CloseHandle(h); return false; }
  fileSize = (unsigned long long)sz.QuadPart;

  std::vector<unsigned char> head((size_t)std::min<long long>(sz.QuadPart, 64 * 1024));
  DWORD read = 0;
  ReadFile(h, head.data(), (DWORD)head.size(), &read, nullptr);
  head.resize(read);

  std::vector<unsigned char> tail(2);
  LARGE_INTEGER pos{}; pos.QuadPart = sz.QuadPart - 2;
  SetFilePointerEx(h, pos, nullptr, FILE_BEGIN);
  DWORD tread = 0;
  ReadFile(h, tail.data(), 2, &tread, nullptr);
  CloseHandle(h);

  info.soi = head.size() >= 2 && head[0] == 0xFF && head[1] == 0xD8;
  info.eoi = tread == 2 && tail[0] == 0xFF && tail[1] == 0xD9;

  // 扫描 SOF 标记取真实宽高
  size_t off = 2;
  while (off + 9 < head.size()) {
    if (head[off] != 0xFF) { off++; continue; }
    unsigned char marker = head[off + 1];
    if (marker == 0xD8 || marker == 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
    if (off + 4 > head.size()) break;
    unsigned int len = ((unsigned int)head[off + 2] << 8) | head[off + 3];
    if (marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC) {
      info.height = ((int)head[off + 5] << 8) | head[off + 6];
      info.width = ((int)head[off + 7] << 8) | head[off + 8];
      break;
    }
    if (marker == 0xDA) break;
    off += 2 + len;
  }
  return true;
}

// ---------------------------------------------------------------- 轻量 JSON 解析
struct JVal {
  enum Type { Null, Bool, Num, Str, Arr, Obj } type = Null;
  std::string s;                                    // Str 内容 / Num 原文
  bool b = false;
  std::vector<JVal> arr;
  std::vector<std::pair<std::string, JVal> > obj;

  const JVal* get(const char* key) const {
    if (type != Obj) return nullptr;
    for (size_t i = 0; i < obj.size(); i++) if (obj[i].first == key) return &obj[i].second;
    return nullptr;
  }
};

class JsonParser {
 public:
  JsonParser(const std::string& text) : t_(text) {}
  bool Parse(JVal& out) { size_t p = 0; SkipWs(p); if (!ParseValue(p, out, 0)) return false; return true; }

 private:
  const std::string& t_;
  void SkipWs(size_t& p) { while (p < t_.size() && (unsigned char)t_[p] <= ' ') p++; }
  static void AppendUtf8(std::string& out, unsigned int cp) {
    if (cp < 0x80) out += (char)cp;
    else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
    else { out += (char)(0xF0 | (cp >> 18)); out += (char)(0x80 | ((cp >> 12) & 0x3F)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
  }
  bool ParseHex4(size_t& p, unsigned int& v) {
    if (p + 4 > t_.size()) return false;
    v = 0;
    for (int i = 0; i < 4; i++) {
      char c = t_[p + i];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
      else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
      else return false;
    }
    p += 4;
    return true;
  }
  bool ParseString(size_t& p, std::string& out) {
    if (p >= t_.size() || t_[p] != '"') return false;
    p++;
    out.clear();
    while (p < t_.size()) {
      char c = t_[p++];
      if (c == '"') return true;
      if (c != '\\') { out += c; continue; }
      if (p >= t_.size()) return false;
      char e = t_[p++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          unsigned int cp = 0;
          if (!ParseHex4(p, cp)) return false;
          if (cp >= 0xD800 && cp <= 0xDBFF && p + 6 <= t_.size() && t_[p] == '\\' && t_[p + 1] == 'u') {
            size_t save = p;
            p += 2;
            unsigned int lo = 0;
            if (ParseHex4(p, lo) && lo >= 0xDC00 && lo <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            else p = save;
          }
          AppendUtf8(out, cp);
          break;
        }
        default: out += e; break;
      }
    }
    return false;
  }
  bool ParseValue(size_t& p, JVal& out, int depth) {
    if (depth > 64) return false;
    SkipWs(p);
    if (p >= t_.size()) return false;
    char c = t_[p];
    if (c == '{') {
      p++; out.type = JVal::Obj;
      SkipWs(p);
      if (p < t_.size() && t_[p] == '}') { p++; return true; }
      while (p < t_.size()) {
        SkipWs(p);
        std::string key;
        if (!ParseString(p, key)) return false;
        SkipWs(p);
        if (p >= t_.size() || t_[p] != ':') return false;
        p++;
        JVal v;
        if (!ParseValue(p, v, depth + 1)) return false;
        out.obj.push_back(std::make_pair(key, v));
        SkipWs(p);
        if (p < t_.size() && t_[p] == ',') { p++; continue; }
        if (p < t_.size() && t_[p] == '}') { p++; return true; }
        return false;
      }
      return false;
    }
    if (c == '[') {
      p++; out.type = JVal::Arr;
      SkipWs(p);
      if (p < t_.size() && t_[p] == ']') { p++; return true; }
      while (p < t_.size()) {
        JVal v;
        if (!ParseValue(p, v, depth + 1)) return false;
        out.arr.push_back(v);
        SkipWs(p);
        if (p < t_.size() && t_[p] == ',') { p++; continue; }
        if (p < t_.size() && t_[p] == ']') { p++; return true; }
        return false;
      }
      return false;
    }
    if (c == '"') { out.type = JVal::Str; return ParseString(p, out.s); }
    if (c == 't' || c == 'f' || c == 'n') {
      if (t_.compare(p, 4, "true") == 0) { out.type = JVal::Bool; out.b = true; p += 4; return true; }
      if (t_.compare(p, 5, "false") == 0) { out.type = JVal::Bool; out.b = false; p += 5; return true; }
      if (t_.compare(p, 4, "null") == 0) { out.type = JVal::Null; p += 4; return true; }
      return false;
    }
    // number
    size_t start = p;
    while (p < t_.size() && (isdigit((unsigned char)t_[p]) || t_[p] == '-' || t_[p] == '+' || t_[p] == '.' || t_[p] == 'e' || t_[p] == 'E')) p++;
    if (p == start) return false;
    out.type = JVal::Num;
    out.s = t_.substr(start, p - start);
    return true;
  }
};

// ---------------------------------------------------------------- mzstatic 片段
// 从 mzstatic artwork URL 提取 "/v4/<xx>/<xx>/<xx>/<UUID>/" 中的片段键 (小写)
static bool ExtractMzFragment(const std::string& url, std::string& fragment) {
  size_t pos = url.find("/v4/");
  if (pos == std::string::npos) return false;
  size_t i = pos + 4;
  struct Seg { int len; };
  static const int segs[3] = { 2, 2, 2 };
  std::string frag;
  for (int s = 0; s < 3; s++) {
    if (i + segs[s] + 1 > url.size()) return false;
    std::string part = url.substr(i, segs[s]);
    for (char c : part) if (!isxdigit((unsigned char)c)) return false;
    frag += ToLowerAscii(part);
    frag += "/";
    i += segs[s] + 1;
  }
  // UUID: 8-4-4-4-12
  static const int uuidLens[5] = { 8, 4, 4, 4, 12 };
  std::string uuid;
  for (int s = 0; s < 5; s++) {
    if (i + uuidLens[s] > url.size()) return false;
    std::string part = url.substr(i, uuidLens[s]);
    for (char c : part) if (!isxdigit((unsigned char)c)) return false;
    uuid += ToLowerAscii(part);
    i += uuidLens[s];
    if (s < 4) {
      if (i >= url.size() || url[i] != '-') return false;
      uuid += "-";
      i++;
    }
  }
  fragment = frag + uuid;
  return true;
}

// ---------------------------------------------------------------- 文件系统辅助
static bool FileExistsW(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static bool DirExistsW(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

static bool ReadFileUtf8(const std::wstring& p, std::string& out) {
  HANDLE h = CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER sz{};
  if (!GetFileSizeEx(h, &sz) || sz.QuadPart <= 0) { CloseHandle(h); return false; }
  out.resize((size_t)sz.QuadPart);
  DWORD total = 0, read = 0;
  while (total < out.size() && ReadFile(h, &out[total], (DWORD)std::min<size_t>(out.size() - total, 1u << 20), &read, nullptr) && read > 0) {
    total += read;
  }
  CloseHandle(h);
  out.resize(total);
  return total > 0;
}

static bool CopyFileW2(const std::wstring& from, const std::wstring& to) {
  return CopyFileW(from.c_str(), to.c_str(), FALSE) != 0;
}

// ---------------------------------------------------------------- artwork 索引
struct IndexEntry { std::string artworkId; std::string source; };
// 同一 mzstatic 片段可能同时存在于 Store_1 与 Radio_2 (相同封面在两个库各自缓存),
// 因此每个片段保留全部来源候选, 匹配时逐个尝试。
typedef std::map<std::string, std::vector<IndexEntry> > FragmentIndex;

static std::wstring TempDirForRun() {
  wchar_t tmp[MAX_PATH] = { 0 };
  GetTempPathW(MAX_PATH, tmp);
  std::wstring dir = std::wstring(tmp) + L"MineRadioCoverResolver\\" + std::to_wstring(GetCurrentProcessId());
  CreateDirectoryW((std::wstring(tmp) + L"MineRadioCoverResolver").c_str(), nullptr);
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir;
}

// 只读打开 SQLite; 若无法读取 WAL (只读环境), 复制三件到 MineRadio 自己的临时目录再读。
static bool LoadArtworkIndexFromDb(const std::wstring& dbPath, const std::string& source,
                                   FragmentIndex& index, std::wstring& tempCopyUsed) {
  std::wstring openPath = dbPath;
  sqlite3* db = nullptr;
  int rc = sqlite3_open_v2(WideToUtf8(dbPath).c_str(), &db, SQLITE_OPEN_READONLY, nullptr);
  bool opened = (rc == SQLITE_OK && db != nullptr);
  if (opened) {
    sqlite3_stmt* probe = nullptr;
    if (sqlite3_prepare_v2(db, "SELECT 1 FROM artwork_source LIMIT 1", -1, &probe, nullptr) != SQLITE_OK) opened = false;
    if (probe) sqlite3_finalize(probe);
    if (!opened) { sqlite3_close(db); db = nullptr; }
  }
  if (!opened) {
    // 回退: 复制 .sqlite / -wal / -shm 到临时目录 (绝不修改 Apple Music 原始文件)
    std::wstring dir = TempDirForRun();
    std::wstring base = dbPath.substr(dbPath.find_last_of(L'\\') + 1);
    std::wstring dst = dir + L"\\" + base;
    if (!CopyFileW2(dbPath, dst)) return false;
    CopyFileW2(dbPath + L"-wal", dst + L"-wal");
    CopyFileW2(dbPath + L"-shm", dst + L"-shm");
    tempCopyUsed = dst;
    openPath = dst;
    rc = sqlite3_open_v2(WideToUtf8(openPath).c_str(), &db, SQLITE_OPEN_READONLY, nullptr);
    if (rc != SQLITE_OK || !db) { if (db) sqlite3_close(db); return false; }
  }

  sqlite3_exec(db, "PRAGMA query_only=1", nullptr, nullptr, nullptr);
  bool ok = false;
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db, "SELECT artwork_id, location FROM artwork_source", -1, &stmt, nullptr) == SQLITE_OK) {
    ok = true;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
      const unsigned char* id = sqlite3_column_text(stmt, 0);
      const unsigned char* loc = sqlite3_column_text(stmt, 1);
      if (!id || !loc) continue;
      std::string fragment;
      if (!ExtractMzFragment(std::string((const char*)loc), fragment)) continue;
      std::vector<IndexEntry>& bucket = index[fragment];
      const std::string artId((const char*)id);
      bool dup = false;
      for (size_t i = 0; i < bucket.size(); i++) {
        if (bucket[i].artworkId == artId && bucket[i].source == source) { dup = true; break; }
      }
      if (!dup) {
        IndexEntry e; e.artworkId = artId; e.source = source;
        bucket.push_back(e);
      }
    }
  }
  if (stmt) sqlite3_finalize(stmt);
  sqlite3_close(db);
  return ok;
}

// ---------------------------------------------------------------- cache_items 查询
struct CacheItem {
  bool found = false;
  int sizeKind = 1;
  std::string extension;
  std::string imageHash;
  int width = 0, height = 0, status = 0;
};

static CacheItem QueryCacheItem(const std::wstring& dbPath, const std::string& artworkId) {
  CacheItem item;
  std::wstring openPath = dbPath;
  if (!FileExistsW(openPath)) return item;
  sqlite3* db = nullptr;
  if (sqlite3_open_v2(WideToUtf8(openPath).c_str(), &db, SQLITE_OPEN_READONLY, nullptr) != SQLITE_OK || !db) {
    if (db) sqlite3_close(db);
    return item;
  }
  sqlite3_exec(db, "PRAGMA query_only=1", nullptr, nullptr, nullptr);
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db, "SELECT size_kind, extension, image_hash, width, height, status FROM cache_items WHERE artwork_id = ?", -1, &stmt, nullptr) == SQLITE_OK) {
    sqlite3_bind_text(stmt, 1, artworkId.c_str(), -1, SQLITE_TRANSIENT);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
      item.found = true;
      item.sizeKind = sqlite3_column_int(stmt, 0);
      const unsigned char* ext = sqlite3_column_text(stmt, 1);
      const unsigned char* hash = sqlite3_column_text(stmt, 2);
      item.extension = ext ? (const char*)ext : "jpeg";
      item.imageHash = hash ? (const char*)hash : "";
      item.width = sqlite3_column_int(stmt, 3);
      item.height = sqlite3_column_int(stmt, 4);
      item.status = sqlite3_column_int(stmt, 5);
    }
  }
  if (stmt) sqlite3_finalize(stmt);
  sqlite3_close(db);
  return item;
}

// ---------------------------------------------------------------- 曲目候选
struct TrackCandidate {
  int score = -1;
  std::string artworkUrl;
  std::string name, artist, album;
};

static void CollectSongs(const JVal& node, const std::string& wantTitleLower,
                         const std::string& wantArtistLower, const std::string& wantAlbumLower,
                         std::vector<TrackCandidate>& out, int depth) {
  if (depth > 32) return;
  if (node.type == JVal::Obj) {
    const JVal* attrs = node.get("attributes");
    if (attrs && attrs->type == JVal::Obj) {
      const JVal* nm = attrs->get("name");
      const JVal* ar = attrs->get("artistName");
      const JVal* al = attrs->get("albumName");
      const JVal* aw = attrs->get("artwork");
      const std::string name = nm && nm->type == JVal::Str ? nm->s : std::string();
      const std::string nameLower = ToLowerAscii(Trim(name));
      if (!nameLower.empty() && nameLower == wantTitleLower && aw && aw->type == JVal::Obj) {
        const JVal* url = aw->get("url");
        if (url && url->type == JVal::Str && !url->s.empty()) {
          TrackCandidate c;
          c.artworkUrl = url->s;
          c.name = name;
          c.artist = ar && ar->type == JVal::Str ? ar->s : std::string();
          c.album = al && al->type == JVal::Str ? al->s : std::string();
          const std::string cArtistLower = ToLowerAscii(Trim(NormalizeArtist(c.artist)));
          const std::string cAlbumLower = ToLowerAscii(Trim(c.album));
          c.score = 10;  // title 命中
          if (!wantArtistLower.empty() && !cArtistLower.empty()) {
            if (cArtistLower == wantArtistLower) c.score += 40;
            else if (cArtistLower.find(wantArtistLower) != std::string::npos ||
                     wantArtistLower.find(cArtistLower) != std::string::npos) c.score += 25;
            else c.score -= 15;  // 同名不同 artist 明确降权
          }
          if (!wantAlbumLower.empty() && !cAlbumLower.empty()) {
            if (cAlbumLower == wantAlbumLower) c.score += 20;
            else if (cAlbumLower.find(wantAlbumLower) != std::string::npos ||
                     wantAlbumLower.find(cAlbumLower) != std::string::npos) c.score += 10;
          }
          out.push_back(c);
        }
      }
    }
    for (size_t i = 0; i < node.obj.size(); i++) CollectSongs(node.obj[i].second, wantTitleLower, wantArtistLower, wantAlbumLower, out, depth + 1);
  } else if (node.type == JVal::Arr) {
    for (size_t i = 0; i < node.arr.size(); i++) CollectSongs(node.arr[i], wantTitleLower, wantArtistLower, wantAlbumLower, out, depth + 1);
  }
}

struct JsonFileEntry { std::wstring path; ULONGLONG mtime = 0; unsigned long long size = 0; };

static void CollectJsonFiles(const std::wstring& dir, std::vector<JsonFileEntry>& out, int depth) {
  if (depth > 2) return;
  WIN32_FIND_DATAW fd{};
  HANDLE h = FindFirstFileW((dir + L"\\*").c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
    std::wstring full = dir + L"\\" + fd.cFileName;
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      CollectJsonFiles(full, out, depth + 1);
    } else {
      size_t n = wcslen(fd.cFileName);
      if (n > 5 && _wcsicmp(fd.cFileName + n - 5, L".json") == 0) {
        ULARGE_INTEGER li{}; li.LowPart = fd.ftLastWriteTime.dwLowDateTime; li.HighPart = fd.ftLastWriteTime.dwHighDateTime;
        JsonFileEntry e; e.path = full; e.mtime = li.QuadPart;
        e.size = ((unsigned long long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
        out.push_back(e);
      }
    }
  } while (FindNextFileW(h, &fd));
  FindClose(h);
}

// ---------------------------------------------------------------- Apple Music 定位
struct AmPaths {
  bool found = false;
  std::wstring packageRoot;
  std::wstring storeDb, storeArtworkDir, storeBase;
  std::wstring radioDb, radioArtworkDir, radioBase;
  std::wstring inetCacheDir;
};

static AmPaths LocateAppleMusic() {
  AmPaths p;
  wchar_t lad[MAX_PATH] = { 0 };
  if (GetEnvironmentVariableW(L"LOCALAPPDATA", lad, MAX_PATH) == 0) return p;
  std::wstring pattern = std::wstring(lad) + L"\\Packages\\AppleInc.AppleMusicWin_*";

  WIN32_FIND_DATAW fd{};
  HANDLE h = FindFirstFileW(pattern.c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return p;
  std::vector<std::wstring> candidates;
  do {
    if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
    std::wstring root = std::wstring(lad) + L"\\Packages\\" + fd.cFileName;
    std::wstring agent = root + L"\\LocalCache\\Local\\Apple\\AMPLibraryAgent";
    if (!DirExistsW(agent)) continue;
    if (!FileExistsW(agent + L"\\Store_1\\artwork.sqlite") && !FileExistsW(agent + L"\\Radio_2\\artwork.sqlite")) continue;
    candidates.push_back(root);
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  if (candidates.empty()) return p;

  // 多个包目录时选择 Store artwork.sqlite 最新修改者
  std::wstring best; ULONGLONG bestTime = 0;
  for (const std::wstring& root : candidates) {
    std::wstring db = root + L"\\LocalCache\\Local\\Apple\\AMPLibraryAgent\\Store_1\\artwork.sqlite";
    ULONGLONG t = 0;
    WIN32_FILE_ATTRIBUTE_DATA fad{};
    if (GetFileAttributesExW(db.c_str(), GetFileExInfoStandard, &fad)) {
      ULARGE_INTEGER li{}; li.LowPart = fad.ftLastWriteTime.dwLowDateTime; li.HighPart = fad.ftLastWriteTime.dwHighDateTime;
      t = li.QuadPart;
    }
    if (best.empty() || t > bestTime) { best = root; bestTime = t; }
  }

  std::wstring agent = best + L"\\LocalCache\\Local\\Apple\\AMPLibraryAgent";
  p.packageRoot = best;
  p.storeBase = agent + L"\\Store_1";
  p.storeDb = p.storeBase + L"\\artwork.sqlite";
  p.storeArtworkDir = p.storeBase + L"\\artwork";
  p.radioBase = agent + L"\\Radio_2";
  p.radioDb = p.radioBase + L"\\artwork.sqlite";
  p.radioArtworkDir = p.radioBase + L"\\artwork";
  p.inetCacheDir = best + L"\\AC\\INetCache";
  p.found = true;
  return p;
}

// ---------------------------------------------------------------- 输出
static void EmitJsonLine(const std::string& line) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  DWORD written = 0;
  std::string s = line + "\n";
  WriteFile(out, s.data(), (DWORD)s.size(), &written, nullptr);
}

static std::string g_debugExtra;  // --debug 时的诊断字段 (默认空, 不影响正式输出)

static int Fail(const char* reason, const char* stage, int code) {
  EmitJsonLine(std::string("{\"ok\":false,\"reason\":\"") + reason + "\",\"stage\":\"" + stage + "\"" + g_debugExtra + "}");
  return code;
}

// ---------------------------------------------------------------- main
int main() {
  Budget budget;
  std::string argTitle, argArtist, argAlbum, argCopyTo;
  int timeoutMs = kDefaultTimeoutMs;
  bool debugFlag = false;

  // 宽字符命令行 -> UTF-8 参数 (支持中文标题/路径)
  int argcW = 0;
  LPWSTR* argvW = CommandLineToArgvW(GetCommandLineW(), &argcW);
  std::vector<std::string> args;
  for (int i = 1; i < argcW; i++) args.push_back(WideToUtf8(argvW[i]));
  if (argvW) LocalFree(argvW);

  std::string command;
  for (size_t i = 0; i < args.size(); i++) {
    const std::string& a = args[i];
    if (a == "--title" && i + 1 < args.size()) { argTitle = args[++i]; }
    else if (a == "--artist" && i + 1 < args.size()) { argArtist = args[++i]; }
    else if (a == "--album" && i + 1 < args.size()) { argAlbum = args[++i]; }
    else if (a == "--copy-to" && i + 1 < args.size()) { argCopyTo = args[++i]; }
    else if (a == "--timeout-ms" && i + 1 < args.size()) { timeoutMs = atoi(args[++i].c_str()); }
    else if (a == "--debug") { debugFlag = true; }
    else if (a == "--json") { /* 输出始终为 JSON */ }
    else if (command.empty()) { command = a; }
  }
  budget.limitMs = (timeoutMs > 0 && timeoutMs < 60000) ? timeoutMs : kDefaultTimeoutMs;

  if (command != "resolve") {
    EmitJsonLine("{\"ok\":false,\"reason\":\"BAD_ARGS\",\"stage\":\"args\"}");
    return EXIT_TIMEOUT_OR_IO;
  }
  if (Trim(argTitle).empty()) {
    EmitJsonLine("{\"ok\":false,\"reason\":\"MISSING_TITLE\",\"stage\":\"args\"}");
    return EXIT_TIMEOUT_OR_IO;
  }

  const std::string wantTitleLower = ToLowerAscii(Trim(argTitle));
  const std::string wantArtistLower = ToLowerAscii(Trim(NormalizeArtist(argArtist)));
  const std::string wantAlbumLower = ToLowerAscii(Trim(argAlbum));

  // 1) 定位 Apple Music 数据目录
  AmPaths am = LocateAppleMusic();
  if (!am.found) return Fail("APPLE_MUSIC_NOT_FOUND", "locate", EXIT_NO_METADATA_JSON);
  if (budget.expired()) return Fail("TIMEOUT", "locate", EXIT_TIMEOUT_OR_IO);

  // 2) 建立 artwork 索引 (fragment -> artwork_id)
  FragmentIndex index;
  std::wstring tempCopy;
  if (FileExistsW(am.storeDb)) LoadArtworkIndexFromDb(am.storeDb, "store", index, tempCopy);
  if (FileExistsW(am.radioDb)) LoadArtworkIndexFromDb(am.radioDb, "radio", index, tempCopy);
  if (index.empty()) return Fail("NO_ARTWORK_INDEX", "artwork-index", EXIT_NO_ARTWORK_MATCH);
  if (budget.expired()) return Fail("TIMEOUT", "artwork-index", EXIT_TIMEOUT_OR_IO);

  // 3) 扫描 INetCache JSON (mtime 倒序, 有界)
  std::vector<JsonFileEntry> files;
  if (DirExistsW(am.inetCacheDir)) CollectJsonFiles(am.inetCacheDir, files, 0);
  if (files.empty()) return Fail("NO_METADATA_JSON", "metadata-json", EXIT_NO_METADATA_JSON);
  std::sort(files.begin(), files.end(), [](const JsonFileEntry& a, const JsonFileEntry& b) { return a.mtime > b.mtime; });

  const std::string titleNeedle = argTitle;
  std::vector<TrackCandidate> candidates;
  size_t scannedFiles = 0;
  unsigned long long scannedBytes = 0;
  size_t preHits = 0;
  size_t parsedOk = 0;
  bool sawTitleButNoArtwork = false;

  for (const JsonFileEntry& f : files) {
    if (scannedFiles >= kMaxJsonFilesScanned) break;
    if (scannedBytes >= kMaxTotalJsonBytes) break;
    if (budget.expired()) break;
    if (f.size == 0 || f.size > kMaxJsonFileBytes) continue;

    std::string text;
    if (!ReadFileUtf8(f.path, text)) continue;
    scannedFiles++;
    scannedBytes += text.size();

    // 快速预筛: 文件必须包含目标 title 字节序列
    if (text.find(titleNeedle) == std::string::npos) continue;
    preHits++;

    JVal root;
    JsonParser parser(text);
    if (!parser.Parse(root)) continue;
    parsedOk++;
    CollectSongs(root, wantTitleLower, wantArtistLower, wantAlbumLower, candidates, 0);
    if (!candidates.empty()) {
      // 已找到带 artwork 的候选: 足够高分的可直接结束
      int bestScore = 0;
      for (const TrackCandidate& c : candidates) bestScore = std::max(bestScore, c.score);
      if (bestScore >= 50) break;
    }
  }

  if (debugFlag) {
    g_debugExtra = ",\"dbg\":{\"jsonFiles\":" + std::to_string(files.size()) +
                   ",\"scanned\":" + std::to_string(scannedFiles) +
                   ",\"bytes\":" + std::to_string(scannedBytes) +
                   ",\"preHits\":" + std::to_string(preHits) +
                   ",\"parsed\":" + std::to_string(parsedOk) +
                   ",\"candidates\":" + std::to_string(candidates.size()) +
                   ",\"indexSize\":" + std::to_string(index.size()) +
                   ",\"titleLen\":" + std::to_string(argTitle.size()) +
                   ",\"elapsedMs\":" + std::to_string((unsigned long long)budget.elapsed()) + "}";
  }

  if (candidates.empty()) {
    // 时间预算耗尽导致的提前收工必须报 TIMEOUT, 而不是"没有元数据"
    if (budget.expired()) return Fail("TIMEOUT", "metadata-json", EXIT_TIMEOUT_OR_IO);
    if (sawTitleButNoArtwork) return Fail("NO_ARTWORK_MATCH", "artwork-index", EXIT_NO_ARTWORK_MATCH);
    return Fail("NO_METADATA_JSON", "metadata-json", EXIT_NO_METADATA_JSON);
  }

  std::sort(candidates.begin(), candidates.end(), [](const TrackCandidate& a, const TrackCandidate& b) { return a.score > b.score; });
  bool anyFragmentMatched = false;   // 曲目 artwork URL 片段是否命中本地 artwork 索引
  for (const TrackCandidate& c : candidates) {
    if (budget.expired()) return Fail("TIMEOUT", "match", EXIT_TIMEOUT_OR_IO);

    std::string fragment;
    if (!ExtractMzFragment(c.artworkUrl, fragment)) continue;
    FragmentIndex::const_iterator it = index.find(fragment);
    if (it == index.end()) continue;
    anyFragmentMatched = true;
    // 同一片段可能同时存在于 Store_1 与 Radio_2: 逐个来源尝试 (store 排在前面)
    for (size_t srcIdx = 0; srcIdx < it->second.size(); srcIdx++) {
    const IndexEntry& entry = it->second[srcIdx];

    const std::wstring db = (entry.source == "radio") ? am.radioDb : am.storeDb;
    const std::wstring artworkDir = (entry.source == "radio") ? am.radioArtworkDir : am.storeArtworkDir;
    CacheItem item = QueryCacheItem(db, entry.artworkId);
    if (!item.found || item.status != 1) continue;
    if (!item.extension.empty() && ToLowerAscii(item.extension) != "jpeg") continue;

    std::wstring filePath = artworkDir + L"\\" + Utf8ToWide(entry.artworkId) + L"_sk" + std::to_wstring(item.sizeKind) + L"." + Utf8ToWide(item.extension.empty() ? std::string("jpeg") : item.extension);
    if (!FileExistsW(filePath)) {
      std::wstring alt = artworkDir + L"\\" + Utf8ToWide(entry.artworkId) + L"_sk1.jpeg";
      if (FileExistsW(alt)) filePath = alt; else continue;
    }

    // 4) 完整性校验 (容忍 Apple Music 正在写入的竞态: 短暂重试)
    std::string sha;
    JpegInfo info;
    unsigned long long bytes = 0;
    bool verified = false;
    for (int attempt = 0; attempt <= kCorruptRetryCount && !verified; attempt++) {
      info = JpegInfo();
      bytes = 0;
      sha.clear();
      if (!InspectJpeg(filePath, info, bytes)) { Sleep(kCorruptRetrySleepMs); continue; }
      if (!info.soi || !info.eoi) { Sleep(kCorruptRetrySleepMs); continue; }
      if (!Sha256File(filePath, sha)) { Sleep(kCorruptRetrySleepMs); continue; }
      if (!item.imageHash.empty() && ToLowerAscii(sha) != ToLowerAscii(item.imageHash)) {
        if (budget.expired()) break;
        Sleep(kCorruptRetrySleepMs);
        continue;
      }
      verified = true;
    }
    if (!verified) continue;

    // 5) 可选复制到调用方指定路径 (仅允许非 Apple Music 目录)
    std::string outPath = WideToUtf8(filePath);
    if (!argCopyTo.empty()) {
      std::wstring dstW = Utf8ToWide(argCopyTo);
      std::string dstLower = ToLowerAscii(WideToUtf8(dstW));   // ascii fold 足够比较路径前缀
      std::string rootLower = ToLowerAscii(WideToUtf8(am.packageRoot));
      if (dstLower.find(rootLower) == 0) {
        return Fail("COPY_TARGET_INSIDE_APPLE_MUSIC", "copy", EXIT_TIMEOUT_OR_IO);
      }
      std::wstring parent = dstW.substr(0, dstW.find_last_of(L'\\'));
      if (!parent.empty()) CreateDirectoryW(parent.c_str(), nullptr);
      if (!CopyFileW2(filePath, dstW)) return Fail("COPY_FAILED", "copy", EXIT_TIMEOUT_OR_IO);
      outPath = argCopyTo;
    }

    std::string json;
    json += "{\"ok\":true";
    json += ",\"artworkId\":\"" + JsonEscape(entry.artworkId) + "\"";
    json += ",\"path\":\"" + JsonEscape(outPath) + "\"";
    json += ",\"width\":" + std::to_string(info.width > 0 ? info.width : item.width);
    json += ",\"height\":" + std::to_string(info.height > 0 ? info.height : item.height);
    json += ",\"bytes\":" + std::to_string((unsigned long long)bytes);
    json += ",\"sha256\":\"" + JsonEscape(sha) + "\"";
    json += ",\"source\":\"" + entry.source + "\"";
    json += ",\"stage\":\"ok\"";
    if (budget.elapsed() > 0) json += ",\"elapsedMs\":" + std::to_string((unsigned long long)budget.elapsed());
    json += g_debugExtra;   // --debug 时附诊断字段 (默认空)
    json += "}";
    EmitJsonLine(json);
    return EXIT_OK;
    }  // end: for each artwork source entry of this fragment
  }

  // 片段命中索引但文件不可用 -> 4; 片段根本没在本地 artwork 索引中 (未缓存) -> 3
  if (!anyFragmentMatched) return Fail("NO_ARTWORK_MATCH", "artwork-index", EXIT_NO_ARTWORK_MATCH);
  return Fail("FILE_MISSING_OR_CORRUPT", "file", EXIT_FILE_MISSING_OR_CORRUPT);
}
