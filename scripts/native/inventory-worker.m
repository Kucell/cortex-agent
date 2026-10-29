// Native read-only inventory worker. Never ship or invoke without the authenticated
// launcher. This source has no signing credentials or install-time build hooks.
#import <Foundation/Foundation.h>
#include <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <dirent.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
static NSUInteger sequence = 0, entryCount = 0, discoveredCount = 1;
static uint64_t inputBytes = 0, outputBytes = 0;
static CC_SHA256_CTX streamHash;
static void die(const char *code) { fprintf(stderr, "%s\n", code); exit(2); }
static void changed(void) { die("MIGRATION_SOURCE_CHANGED"); }
static void writeAll(const void *buffer, size_t count) {
  const unsigned char *p = buffer;
  while (count) { ssize_t n = write(STDOUT_FILENO, p, count); if (n < 0 && errno == EINTR) continue;
    if (n <= 0) die("MIGRATION_NATIVE_OUTPUT_FAILED"); p += n; count -= (size_t)n; }
}
static NSString *hex(const unsigned char *bytes) {
  char out[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) snprintf(out + i * 2, 3, "%02x", bytes[i]);
  return [NSString stringWithUTF8String:out];
}
static NSString *hash(NSData *data) {
  unsigned char bytes[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes, (CC_LONG)data.length, bytes); return hex(bytes);
}
static void emit(NSMutableDictionary *row, BOOL terminal) {
  row[@"seq"] = @(sequence++);
  NSData *data = [NSJSONSerialization dataWithJSONObject:row options:0 error:NULL];
  if (!data || data.length > 1024 * 1024) die("MIGRATION_INVENTORY_LIMIT");
  outputBytes += data.length + 4;
  if (outputBytes > 96 * 1024 * 1024) die("MIGRATION_INVENTORY_LIMIT");
  if (!terminal) CC_SHA256_Update(&streamHash, data.bytes, (CC_LONG)data.length);
  uint32_t n = htonl((uint32_t)data.length); writeAll(&n, 4); writeAll(data.bytes, data.length);
}
static BOOL same(struct stat *a, struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode &&
    a->st_nlink == b->st_nlink && a->st_size == b->st_size &&
    a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
    a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}
static void visit(int parent, const char *name, NSString *rel, unsigned depth) {
  if (depth > 128 || entryCount >= 20000) die("MIGRATION_INVENTORY_LIMIT");
  struct stat before, opened, after;
  if (fstatat(parent, name, &before, AT_SYMLINK_NOFOLLOW)) die("MIGRATION_UNSAFE_PATH");
  BOOL directory = S_ISDIR(before.st_mode);
  if (!directory && (!S_ISREG(before.st_mode) || before.st_nlink != 1)) die("MIGRATION_UNSAFE_PATH");
  if (before.st_size < 0 || (uint64_t)before.st_size > 9007199254740991ULL ||
      (uint64_t)before.st_ino > 9007199254740991ULL || (uint64_t)before.st_dev > 9007199254740991ULL)
    die("MIGRATION_UNREPRESENTABLE_IDENTITY");
  int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (directory ? O_DIRECTORY : 0));
  if (fd < 0) die("MIGRATION_UNSAFE_PATH");
  if (fstat(fd, &opened) || !same(&before, &opened)) changed();
  NSMutableDictionary *entry = [@{@"path": rel, @"type": directory ? @"directory" : @"file",
    @"mode": @(before.st_mode & 07777), @"size": @(before.st_size), @"dev": @(before.st_dev), @"ino": @(before.st_ino)} mutableCopy];
  entryCount++;
  if (directory) {
    emit([@{@"type": @"entry", @"entry": entry} mutableCopy], NO);
    int enumFd = dup(fd); if (enumFd < 0) die("MIGRATION_FD_EXHAUSTED");
    DIR *dir = fdopendir(enumFd); if (!dir) { close(enumFd); die("MIGRATION_UNSAFE_PATH"); }
    NSMutableArray<NSString *> *names = [NSMutableArray array];
    errno = 0; struct dirent *item;
    while ((item = readdir(dir))) {
      if (!strcmp(item->d_name, ".") || !strcmp(item->d_name, "..")) continue;
      if (++discoveredCount > 20000) die("MIGRATION_INVENTORY_LIMIT");
      NSString *child = [[NSString alloc] initWithBytes:item->d_name length:strlen(item->d_name) encoding:NSUTF8StringEncoding];
      if (!child || [child containsString:@"\\"]) die("MIGRATION_UNREPRESENTABLE_PATH");
      [names addObject:child]; errno = 0;
    }
    if (errno) die("MIGRATION_READ_FAILED");
    if (closedir(dir)) die("MIGRATION_READ_FAILED"); // closes enumFd; fd stays owned here
    [names sortUsingComparator:^NSComparisonResult(NSString *a, NSString *b) {
      // JS default sort compares UTF-16 code units, not locale or normalization.
      NSUInteger length = MIN(a.length, b.length);
      for (NSUInteger i = 0; i < length; i++) { unichar x = [a characterAtIndex:i], y = [b characterAtIndex:i];
        if (x != y) return x < y ? NSOrderedAscending : NSOrderedDescending; }
      return a.length == b.length ? NSOrderedSame : a.length < b.length ? NSOrderedAscending : NSOrderedDescending;
    }];
    for (NSString *child in names) @autoreleasepool {
      NSString *next = [rel stringByAppendingFormat:@"/%@", child];
      if ([next lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 4096) die("MIGRATION_INVENTORY_LIMIT");
      visit(fd, child.UTF8String, next, depth + 1);
    }
  } else {
    inputBytes += (uint64_t)before.st_size;
    if (before.st_size > 8 * 1024 * 1024 || inputBytes > 64 * 1024 * 1024) die("MIGRATION_INVENTORY_LIMIT");
    NSMutableData *data = [NSMutableData data]; unsigned char buffer[65536];
    while (data.length <= (NSUInteger)before.st_size) {
      size_t amount = MIN(sizeof(buffer), (NSUInteger)before.st_size + 1 - data.length);
      ssize_t n = read(fd, buffer, amount); if (n < 0 && errno == EINTR) continue;
      if (n < 0) die("MIGRATION_READ_FAILED"); if (!n) break;
      [data appendBytes:buffer length:(NSUInteger)n];
      if (data.length > (NSUInteger)before.st_size) changed();
    }
    if (data.length != (NSUInteger)before.st_size) changed();
    entry[@"sha256"] = hash(data); emit([@{@"type": @"entry", @"entry": entry} mutableCopy], NO);
    for (NSUInteger offset = 0; offset < data.length; offset += 65536) {
      NSData *chunk = [data subdataWithRange:NSMakeRange(offset, MIN((NSUInteger)65536, data.length - offset))];
      emit([@{@"type": @"chunk", @"path": rel, @"offset": @(offset), @"data": [chunk base64EncodedStringWithOptions:0]} mutableCopy], NO);
    }
  }
  if (fstat(fd, &after) || !same(&before, &after) || fstatat(parent, name, &after, AT_SYMLINK_NOFOLLOW) || !same(&before, &after)) changed();
  if (close(fd)) die("MIGRATION_READ_FAILED");
}
// Foundation validates JSON syntax first; this second walk rejects duplicate
// decoded keys that NSJSONSerialization would otherwise silently collapse.
static void space(NSString *s, NSUInteger *i) {
  while (*i < s.length && [[NSCharacterSet whitespaceAndNewlineCharacterSet] characterIsMember:[s characterAtIndex:*i]]) (*i)++;
}
static NSString *stringToken(NSString *s, NSUInteger *i) {
  NSUInteger start = (*i)++; BOOL escaped = NO;
  while (*i < s.length) {
    unichar c = [s characterAtIndex:(*i)++];
    if (!escaped && c == '"') {
      NSData *data = [[s substringWithRange:NSMakeRange(start, *i - start)] dataUsingEncoding:NSUTF8StringEncoding];
      id result = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:NULL];
      if (![result isKindOfClass:[NSString class]]) die("MIGRATION_BAD_REQUEST"); return result;
    }
    if (!escaped && c == '\\') escaped = YES; else escaped = NO;
  }
  die("MIGRATION_BAD_REQUEST"); return nil;
}
static void uniqueKeys(NSString *s, NSUInteger *i, unsigned depth) {
  if (depth > 16) die("MIGRATION_BAD_REQUEST"); space(s, i);
  if (*i >= s.length) die("MIGRATION_BAD_REQUEST");
  unichar c = [s characterAtIndex:*i];
  if (c == '"') { (void)stringToken(s, i); return; }
  if (c == '{' || c == '[') {
    (*i)++; space(s, i); NSMutableSet *keys = [NSMutableSet set]; unichar end = c == '{' ? '}' : ']';
    if ([s characterAtIndex:*i] == end) { (*i)++; return; }
    while (*i < s.length) {
      if (c == '{') { NSString *key = stringToken(s, i); if ([keys containsObject:key]) die("MIGRATION_BAD_REQUEST");
        [keys addObject:key]; space(s, i); (*i)++; }
      uniqueKeys(s, i, depth + 1); space(s, i);
      if ([s characterAtIndex:(*i)++] == end) return; space(s, i);
    }
    die("MIGRATION_BAD_REQUEST");
  }
  while (*i < s.length && ![[NSCharacterSet characterSetWithCharactersInString:@",]} \t\r\n"] characterIsMember:[s characterAtIndex:*i]]) (*i)++;
}
static BOOL integerEquals(id value, long long expected) {
  return [value isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
    [value doubleValue] == (double)expected;
}
int main(int argc, const char **argv) { @autoreleasepool {
  if (argc == 2 && !strcmp(argv[1], "--authenticated-worker")) { unsigned char ready = 1; if (write(3, &ready, 1) != 1) die("MIGRATION_NATIVE_NOT_READY"); close(3); }
  else if (argc != 1) die("MIGRATION_BAD_REQUEST");
  alarm(30);
  NSMutableData *request = [NSMutableData data]; unsigned char buffer[1024]; ssize_t n;
  while ((n = read(STDIN_FILENO, buffer, sizeof(buffer))) != 0) {
    if (n < 0 && errno == EINTR) continue; if (n < 0) die("MIGRATION_BAD_REQUEST");
    [request appendBytes:buffer length:(NSUInteger)n]; if (request.length > 16384) die("MIGRATION_BAD_REQUEST");
  }
  id value = [NSJSONSerialization JSONObjectWithData:request options:0 error:NULL];
  if (!value) die("MIGRATION_BAD_REQUEST");
  NSString *text = [[NSString alloc] initWithData:request encoding:NSUTF8StringEncoding]; if (!text) die("MIGRATION_BAD_REQUEST");
  NSUInteger position = 0; uniqueKeys(text, &position, 0); space(text, &position); if (position != text.length) die("MIGRATION_BAD_REQUEST");
  if (![value isKindOfClass:[NSDictionary class]] || [value count] != 4 || !integerEquals(value[@"protocol"], 1) ||
      ![value[@"operation"] isEqual:@"inventory"] || ![value[@"root"] isKindOfClass:[NSString class]] ||
      ![value[@"limits"] isKindOfClass:[NSDictionary class]] || [value[@"limits"] count] != 3 ||
      !integerEquals(value[@"limits"][@"entries"], 20000) || !integerEquals(value[@"limits"][@"fileBytes"], 8388608) ||
      !integerEquals(value[@"limits"][@"totalBytes"], 67108864)) die("MIGRATION_BAD_REQUEST");
  NSString *root = value[@"root"];
  if (![root hasPrefix:@"/"] || [root containsString:@"\0"] || [root lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 4096) die("MIGRATION_BAD_REQUEST");
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) die("MIGRATION_UNSAFE_PATH");
  for (NSString *part in [root componentsSeparatedByString:@"/"]) {
    if (!part.length) continue; if ([part isEqual:@"."] || [part isEqual:@".."]) die("MIGRATION_BAD_REQUEST");
    int next = openat(fd, part.UTF8String, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) die("MIGRATION_UNSAFE_PATH"); close(fd); fd = next;
  }
  CC_SHA256_Init(&streamHash); emit([@{@"type": @"header", @"protocol": @1} mutableCopy], NO);
  visit(fd, ".agent", @".agent", 0); close(fd);
  unsigned char result[CC_SHA256_DIGEST_LENGTH]; CC_SHA256_Final(result, &streamHash);
  emit([@{@"type": @"end", @"entries": @(entryCount), @"bytes": @(inputBytes), @"digest": hex(result)} mutableCopy], YES);
  return 0;
} }
