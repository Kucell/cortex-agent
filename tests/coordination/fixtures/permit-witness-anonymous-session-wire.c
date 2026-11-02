#include "session-wire.h"
#include <CommonCrypto/CommonHMAC.h>
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static pw_sw_budget *budget;
static int fail_malloc;
static size_t mallocs;
void *pw_sw_test_malloc(size_t n) {
    pw_sw_account_v1 v;assert(pw_sw_budget_inspect_v1(budget,sizeof(v),&v)==PW_SW_OK);
    assert(v.reserved_bytes>=n && v.allocation_attempts==++mallocs);
    if(fail_malloc) return NULL;
    return malloc(n);
}
static unsigned char key[32];
static pw_sw_fields_v1 fields(unsigned variant) {
    pw_sw_fields_v1 f={0};f.direction=variant%2+1;f.type=variant+1;
    f.seq=variant==5?UINT32_MAX:0x01020304+variant;
    f.request_id=variant==5?UINT32_MAX:0xa0b0c0d0+variant;
    f.operation=variant==5?UINT16_MAX:0x1234+variant;
    for(unsigned i=0;i<16;i++) f.session[i]=(unsigned char)(0x10+i);
    for(unsigned i=0;i<32;i++) f.binding[i]=(unsigned char)(0x80+i);
    return f;
}
static void zero(const void *p,size_t n) {const unsigned char *bytes=p;for(size_t i=0;i<n;i++)assert(bytes[i]==0);}
static int verify(const unsigned char *p,size_t n,const pw_sw_fields_v1 *f,int expected) {
    pw_sw_decoded_v1 out;memset(&out,0xa5,sizeof(out));
    int rc=pw_sw_verify_v1(key,32,f,sizeof(*f),p,n,&out,sizeof(out));
    assert(rc==expected);
    if(rc!=PW_SW_OK)zero(&out,sizeof(out));else assert(out.valid && out.payload_bytes==n-98 && out.abi_version==1);
    return rc;
}
static void resign(unsigned char *p,size_t n) {CCHmac(kCCHmacAlgSHA256,key,32,p,n-32,p+n-32);}
static void *wrong_owner(void *unused) {
    (void)unused;pw_sw_frame *out=(void *)1;pw_sw_fields_v1 f=fields(0);
    assert(pw_sw_encode_v1(budget,key,32,&f,sizeof(f),NULL,0,&out)==PW_SW_OWNER && !out);return NULL;
}
static void selftest(void) {
    pw_sw_fields_v1 f=fields(0);pw_sw_frame *frame;unsigned char payload[]={0,255,1,7};
    assert(pw_sw_encode_v1(budget,key,32,&f,sizeof(f),payload,sizeof(payload),&frame)==PW_SW_OK);
    size_t n;const unsigned char *p=pw_sw_frame_view_v1(frame,&n);assert(n==102);verify(p,n,&f,PW_SW_OK);
    unsigned char copy[102];
    for(size_t cut=0;cut<n;cut++)verify(p,cut,&f,PW_SW_SIZE);
    for(size_t i=0;i<n;i++) {memcpy(copy,p,n);copy[i]^=1;verify(copy,n,&f,i<4?PW_SW_SIZE:PW_SW_MAC);}
    // Valid MAC with every interpreted domain/correlation field changed.
    const size_t positions[]={4,5,6,7,8,12,16,18,34,65};
    for(size_t i=0;i<sizeof(positions)/sizeof(positions[0]);i++) {
        memcpy(copy,p,n);copy[positions[i]]^=1;resign(copy,n);
        int rc=positions[i]==8?PW_SW_SEQUENCE:(positions[i]==4||positions[i]==5||positions[i]==7||positions[i]==18)?PW_SW_DOMAIN:PW_SW_CORRELATION;
        verify(copy,n,&f,rc);
    }
    pw_sw_fields_v1 other=f;
    other.direction^=1;verify(p,n,&other,PW_SW_DOMAIN);other=f;
    other.session[15]^=1;verify(p,n,&other,PW_SW_DOMAIN);other=f;
    other.seq++;verify(p,n,&other,PW_SW_SEQUENCE);other=f;
    other.request_id++;verify(p,n,&other,PW_SW_CORRELATION);other=f;
    other.operation++;verify(p,n,&other,PW_SW_CORRELATION);other=f;
    other.type++;verify(p,n,&other,PW_SW_CORRELATION);other=f;
    other.binding[31]^=1;verify(p,n,&other,PW_SW_CORRELATION);
    pw_sw_decoded_v1 decoded;memset(&decoded,0xa5,sizeof(decoded));
    assert(pw_sw_verify_v1(key,32,&f,sizeof(f),p,n,&decoded,sizeof(decoded)-1)==PW_SW_ABI);
    for(size_t i=0;i<sizeof(decoded);i++)assert(((unsigned char *)&decoded)[i]==0xa5);
    unsigned char wrong[32];memcpy(wrong,key,32);wrong[0]^=1;
    assert(pw_sw_verify_v1(wrong,32,&f,sizeof(f),p,n,&decoded,sizeof(decoded))==PW_SW_MAC);zero(&decoded,sizeof(decoded));
    for(unsigned i=0;i<5;i++) {
        other=f;uint64_t *values[]={&other.direction,&other.type,&other.seq,&other.request_id,&other.operation};
        *values[i]=(i<2?UINT8_MAX:i<4?UINT32_MAX:UINT16_MAX)+UINT64_C(1);
        pw_sw_frame *out=(void *)1;pw_sw_account_v1 before,after;
        pw_sw_budget_inspect_v1(budget,sizeof(before),&before);
        assert(pw_sw_encode_v1(budget,key,32,&other,sizeof(other),payload,4,&out)==PW_SW_INPUT && !out);
        pw_sw_budget_inspect_v1(budget,sizeof(after),&after);assert(!memcmp(&before,&after,sizeof(before)));
        assert(pw_sw_verify_v1(key,32,&other,sizeof(other),p,n,&decoded,sizeof(decoded))==PW_SW_INPUT);zero(&decoded,sizeof(decoded));
    }
    for(size_t length=PW_SW_MAX_PAYLOAD+1; ;length=SIZE_MAX) {
        pw_sw_frame *out=(void *)1;
        assert(pw_sw_encode_v1(budget,key,32,&f,sizeof(f),payload,length,&out)==PW_SW_SIZE && !out);
        if(length==SIZE_MAX)break;
    }
    pw_sw_frame *out=(void *)1;
    assert(pw_sw_encode_v1(budget,key,31,&f,sizeof(f),payload,4,&out)==PW_SW_INPUT && !out);
    assert(pw_sw_encode_v1(budget,key,32,&f,sizeof(f)-1,payload,4,&out)==PW_SW_INPUT && !out);
    assert(pw_sw_encode_v1(budget,key,32,&f,sizeof(f),NULL,1,&out)==PW_SW_INPUT && !out);
    assert(pw_sw_verify_v1(key,31,&f,sizeof(f),p,n,&decoded,sizeof(decoded))==PW_SW_INPUT);zero(&decoded,sizeof(decoded));
    assert(pw_sw_verify_v1(key,32,&f,sizeof(f),p,SIZE_MAX,&decoded,sizeof(decoded))==PW_SW_SIZE);zero(&decoded,sizeof(decoded));
    // All-zero unsigned boundaries, and valid raw u8 maximums. The codec does
    // not invent session-state allowlists absent from the JS wire module.
    other=f;other.direction=other.type=other.seq=other.request_id=other.operation=0;
    assert(pw_sw_encode_v1(budget,key,32,&other,sizeof(other),NULL,0,&out)==PW_SW_OK);
    size_t empty_size;const unsigned char *empty=pw_sw_frame_view_v1(out,&empty_size);verify(empty,empty_size,&other,PW_SW_OK);
    other.direction=other.type=UINT8_MAX;other.seq=other.request_id=UINT32_MAX;other.operation=UINT16_MAX;
    assert(pw_sw_encode_v1(budget,key,32,&other,sizeof(other),NULL,0,&out)==PW_SW_OK);
    empty=pw_sw_frame_view_v1(out,&empty_size);verify(empty,empty_size,&other,PW_SW_OK);
    other.seq=UINT64_MAX;assert(pw_sw_encode_v1(budget,key,32,&other,sizeof(other),NULL,0,&out)==PW_SW_INPUT && !out);
    pthread_t thread;assert(!pthread_create(&thread,NULL,wrong_owner,NULL));assert(!pthread_join(thread,NULL));
    fail_malloc=1;pw_sw_account_v1 before,after;pw_sw_budget_inspect_v1(budget,sizeof(before),&before);
    assert(pw_sw_encode_v1(budget,key,32,&f,sizeof(f),payload,4,&out)==PW_SW_SYSTEM && !out);
    pw_sw_budget_inspect_v1(budget,sizeof(after),&after);assert(after.reserved_bytes>before.reserved_bytes);
    assert(after.encoding_attempts==before.encoding_attempts+1);fail_malloc=0;
    while(after.encoding_attempts<PW_SW_MAX_ENCODINGS) {
        assert(pw_sw_encode_v1(budget,key,32,&f,sizeof(f),NULL,0,&out)==PW_SW_OK);
        pw_sw_budget_inspect_v1(budget,sizeof(after),&after);
    }
    assert(pw_sw_encode_v1(budget,key,32,&f,sizeof(f),NULL,0,&out)==PW_SW_BUDGET && !out);
    puts("{\"status\":\"OK\",\"selftest\":true}");
}
static unsigned char *read_input(const char *name,size_t *n) {
    FILE *file=fopen(name,"rb");assert(file);assert(!fseek(file,0,SEEK_END));long size=ftell(file);
    assert(size>=0 && size<=PW_SW_MAX_FRAME+1 && !fseek(file,0,SEEK_SET));*n=(size_t)size;
    unsigned char *p=malloc(*n?*n:1);assert(p);assert(fread(p,1,*n,file)==*n);assert(!fclose(file));return p;
}
int main(int argc,char **argv) {
    assert(argc>=2 && pw_sw_platform_supported_v1());for(unsigned i=0;i<32;i++)key[i]=(unsigned char)i;
    budget=pw_sw_budget_create_v1();assert(budget);
    if(!strcmp(argv[1],"selftest"))selftest();
    else if(!strcmp(argv[1],"budget")) {
        pw_sw_fields_v1 f=fields(0);unsigned char *p=calloc(1,PW_SW_MAX_PAYLOAD);assert(p);pw_sw_frame *frame;
        for(unsigned i=0;i<4;i++)assert(pw_sw_encode_v1(budget,key,32,&f,sizeof(f),p,PW_SW_MAX_PAYLOAD,&frame)==PW_SW_OK);
        assert(pw_sw_encode_v1(budget,key,32,&f,sizeof(f),p,0,&frame)==PW_SW_BUDGET && !frame);
        free(p);puts("{\"status\":\"OK\",\"sharedBudget\":true}");
    } else {
        assert(argc==4);unsigned variant=(unsigned)strtoul(argv[2],NULL,10);assert(variant<=5);
        pw_sw_fields_v1 f=fields(variant);size_t n;unsigned char *p=read_input(argv[3],&n);
        if(!strcmp(argv[1],"encode")) {
            pw_sw_frame *frame;int rc=pw_sw_encode_v1(budget,key,32,&f,sizeof(f),p,n,&frame);assert(rc==PW_SW_OK);
            const unsigned char *bytes=pw_sw_frame_view_v1(frame,&n);assert(fwrite(bytes,1,n,stdout)==n);
        } else {
            pw_sw_decoded_v1 out;memset(&out,0xa5,sizeof(out));
            int rc=pw_sw_verify_v1(key,32,&f,sizeof(f),p,n,&out,sizeof(out));
            if(rc!=PW_SW_OK)zero(&out,sizeof(out));
            printf("{\"result\":\"%s\",\"valid\":%d,\"payloadBytes\":%zu,\"digest\":\"",pw_sw_result_name_v1(rc),out.valid,out.payload_bytes);
            if(out.valid)for(unsigned i=0;i<32;i++)printf("%02x",out.digest[i]);puts("\"}");
        }
        free(p);
    }
    assert(pw_sw_budget_destroy_v1(budget)==PW_SW_OK);return 0;
}
