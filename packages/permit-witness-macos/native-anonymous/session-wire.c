#include "session-wire.h"
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#ifdef __APPLE__
#include <CommonCrypto/CommonHMAC.h>
#include <CommonCrypto/CommonDigest.h>
#include <sys/sysctl.h>
#include <sys/utsname.h>
#endif

struct pw_sw_frame { struct pw_sw_frame *next; struct pw_sw_budget *owner; size_t size; unsigned char bytes[]; };
struct pw_sw_budget { pthread_t owner; pw_sw_account_v1 account; pw_sw_frame *frames; };
static void wipe(void *p,size_t n) { volatile unsigned char *v=p;while(n--) *v++=0; }
static int owned(pw_sw_budget *b) { return b && pthread_equal(b->owner,pthread_self()); }
int pw_sw_platform_supported_v1(void) {
#if defined(__APPLE__) && defined(__aarch64__)
    struct utsname u;char version[32];size_t n=sizeof(version);
    return !uname(&u) && !strcmp(u.release,"27.0.0") && !strcmp(u.machine,"arm64") &&
        !sysctlbyname("kern.osproductversion",version,&n,NULL,0) && !strcmp(version,"27.0.1");
#else
    return 0;
#endif
}
static int fields_valid(const pw_sw_fields_v1 *f,size_t n) {
    return f && n==sizeof(*f) && f->direction<=UINT8_MAX && f->type<=UINT8_MAX &&
        f->seq<=UINT32_MAX && f->request_id<=UINT32_MAX && f->operation<=UINT16_MAX;
}
static void be32(unsigned char *p,uint32_t n) { p[0]=(unsigned char)(n>>24);p[1]=(unsigned char)(n>>16);p[2]=(unsigned char)(n>>8);p[3]=(unsigned char)n; }
static uint32_t u32(const unsigned char *p) { return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3]; }
/* Fixed public-length loop; volatile accumulator prevents early-exit/memcmp
 * substitution. Only the final result is branched on, never a tag prefix. No
 * timing test can prove OS/microarchitectural constant-time behavior. */
static int equal_fixed(const unsigned char *a,const unsigned char *b,size_t n) {
    volatile unsigned diff=0;
    for(size_t i=0;i<n;i++) diff|=(unsigned)(a[i]^b[i]);
    return diff==0;
}
pw_sw_budget *pw_sw_budget_create_v1(void) {
    if(!pw_sw_platform_supported_v1()) return NULL;
    pw_sw_budget *b=calloc(1,sizeof(*b));
    if(b) { b->owner=pthread_self();b->account.capacity_limit=4*(sizeof(pw_sw_frame)+PW_SW_MAX_FRAME); }
    return b;
}
int pw_sw_budget_inspect_v1(pw_sw_budget *b,size_t n,pw_sw_account_v1 *out) {
    if(n!=sizeof(*out)||!out) return PW_SW_ABI;
    if(!owned(b)) return PW_SW_OWNER;
    *out=b->account;return PW_SW_OK;
}
int pw_sw_budget_destroy_v1(pw_sw_budget *b) {
    if(!owned(b)) return PW_SW_OWNER;
    pw_sw_frame *p=b->frames;
    while(p) { pw_sw_frame *next=p->next;wipe(p->bytes,p->size);free(p);p=next; }
    wipe(b,sizeof(*b));free(b);return PW_SW_OK;
}
int pw_sw_encode_v1(pw_sw_budget *b,const unsigned char *key,size_t key_n,
    const pw_sw_fields_v1 *f,size_t f_n,const unsigned char *payload,size_t n,pw_sw_frame **out) {
    if(!out) return PW_SW_INPUT;
    *out=NULL;
    if(!owned(b)) return PW_SW_OWNER;
    if(!pw_sw_platform_supported_v1()) return PW_SW_UNSUPPORTED;
    if(!key || key_n!=PW_SW_KEY_BYTES || !fields_valid(f,f_n) || (n && !payload)) return PW_SW_INPUT;
    if(n>PW_SW_MAX_PAYLOAD) return PW_SW_SIZE; // no addition/narrowing before bound
    size_t length=PW_SW_OVERHEAD+n,charge=sizeof(pw_sw_frame)+length;
    if(b->account.encoding_attempts==PW_SW_MAX_ENCODINGS ||
        charge>b->account.capacity_limit-b->account.reserved_bytes) return PW_SW_BUDGET;
    b->account.reserved_bytes+=charge;b->account.encoding_attempts++;
    b->account.allocation_attempts++; // precedes allocator, never refunded
    pw_sw_frame *result=malloc(charge);
    if(!result) return PW_SW_SYSTEM;
    result->next=b->frames;result->owner=b;result->size=length;
    unsigned char *p=result->bytes;
    be32(p,(uint32_t)(length-4));p[4]=1;p[5]=(unsigned char)f->direction;p[6]=(unsigned char)f->type;p[7]=0;
    be32(p+8,(uint32_t)f->seq);be32(p+12,(uint32_t)f->request_id);
    p[16]=(unsigned char)(f->operation>>8);p[17]=(unsigned char)f->operation;
    memcpy(p+18,f->session,16);memcpy(p+34,f->binding,32);
    if(n) memcpy(p+66,payload,n);
#ifdef __APPLE__
    CCHmac(kCCHmacAlgSHA256,key,key_n,p,length-PW_SW_TAG_BYTES,p+length-PW_SW_TAG_BYTES);
#else
    wipe(result,charge);free(result);return PW_SW_UNSUPPORTED;
#endif
    b->frames=result;*out=result;return PW_SW_OK;
}
const unsigned char *pw_sw_frame_view_v1(pw_sw_frame *f,size_t *n) {
    if(n) *n=0;
    if(!f || !n || !owned(f->owner)) return NULL;
    *n=f->size;return f->bytes;
}
int pw_sw_verify_v1(const unsigned char *key,size_t key_n,const pw_sw_fields_v1 *expected,size_t e_n,
    const unsigned char *p,size_t n,pw_sw_decoded_v1 *out,size_t out_n) {
    if(!out || out_n!=sizeof(*out)) return PW_SW_ABI;
    memset(out,0,sizeof(*out));
    if(!pw_sw_platform_supported_v1()) return PW_SW_UNSUPPORTED;
    if(!key || key_n!=PW_SW_KEY_BYTES || !fields_valid(expected,e_n) || !p) return PW_SW_INPUT;
    if(n<PW_SW_OVERHEAD || n>PW_SW_MAX_FRAME) return PW_SW_SIZE;
    if(u32(p)!=n-4) return PW_SW_SIZE;
    unsigned char mac[32];
#ifdef __APPLE__
    CCHmac(kCCHmacAlgSHA256,key,key_n,p,n-PW_SW_TAG_BYTES,mac);
#else
    return PW_SW_UNSUPPORTED;
#endif
    int good=equal_fixed(mac,p+n-32,32);wipe(mac,sizeof(mac));
    if(!good) return PW_SW_MAC;
    if(p[4]!=1 || p[7]!=0 || p[5]!=expected->direction || !equal_fixed(p+18,expected->session,16)) return PW_SW_DOMAIN;
    uint32_t seq=u32(p+8),id=u32(p+12);uint16_t op=(uint16_t)(((uint16_t)p[16]<<8)|p[17]);
    if(seq!=expected->seq) return PW_SW_SEQUENCE;
    if(p[6]!=expected->type || id!=expected->request_id || op!=expected->operation ||
        !equal_fixed(p+34,expected->binding,32)) return PW_SW_CORRELATION;
    unsigned char digest[32];
#ifdef __APPLE__
    if(!CC_SHA256(p,(CC_LONG)n,digest)) { wipe(digest,sizeof(digest));return PW_SW_SYSTEM; }
#endif
    // Publish only after EVERY check; failed verification has no payload view,
    // digest or valid flag. No heap copy of a maximum frame is needed.
    out->fields=*expected;out->payload=p+66;out->payload_bytes=n-PW_SW_OVERHEAD;
    memcpy(out->digest,digest,sizeof(digest));wipe(digest,sizeof(digest));
    out->abi_version=PW_SW_ABI_V1;out->struct_bytes=sizeof(*out);out->valid=1;
    return PW_SW_OK;
}
const char *pw_sw_result_name_v1(int rc) {
    static const char *const names[]={"OK","INPUT","SIZE","ABI","UNSUPPORTED","OWNER","BUDGET","SYSTEM","MAC","DOMAIN","SEQUENCE","CORRELATION"};
    return rc>=0 && (size_t)rc<sizeof(names)/sizeof(names[0])?names[rc]:"UNKNOWN";
}
