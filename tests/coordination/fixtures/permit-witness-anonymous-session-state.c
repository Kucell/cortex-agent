#include "session-state.h"
#include <CommonCrypto/CommonHMAC.h>
#include <CommonCrypto/CommonDigest.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static unsigned char key[32],id[16];
static pw_ss_root *root;
static int64_t offset_ns;
static unsigned expire_on_clock;
static int fail_malloc;
static int fail_calloc, fail_wire_malloc, fail_wire_calloc;
static size_t expected_charge;
static unsigned charged_allocations;
static FILE *transcript;
void pw_ss_fixed_random(void *p,size_t n){assert(n==32);for(size_t i=0;i<n;i++)((unsigned char *)p)[i]=(unsigned char)(32+i);}
int pw_ss_test_clock(clockid_t clock,struct timespec *t){int rc=clock_gettime(clock,t);if(expire_on_clock && !--expire_on_clock)offset_ns=20000000000LL;uint64_t value=(uint64_t)t->tv_sec*1000000000ULL+t->tv_nsec+(uint64_t)offset_ns;t->tv_sec=(time_t)(value/1000000000ULL);t->tv_nsec=(long)(value%1000000000ULL);return rc;}
static void precharged(size_t n){pw_ss_snapshot_v1 v;assert(!pw_ss_inspect_v1(root,NULL,&v,sizeof(v)));assert(v.capacity_reserved>=n);if(expected_charge)assert(v.capacity_reserved>=expected_charge);charged_allocations++;}
void *pw_ss_test_malloc(size_t n){precharged(n);return fail_malloc?NULL:malloc(n);}
void *pw_ss_test_calloc(size_t count,size_t n){if(root)precharged(count*n);return fail_calloc?NULL:calloc(count,n);}
void *pw_ss_test_wire_malloc(size_t n){precharged(n);return fail_wire_malloc?NULL:malloc(n);}
void *pw_ss_test_wire_calloc(size_t count,size_t n){precharged(count*n);return fail_wire_calloc?NULL:calloc(count,n);}
static pw_ss_snapshot_v1 snapshot(pw_ss_session *s){pw_ss_snapshot_v1 v;assert(!pw_ss_inspect_v1(root,s,&v,sizeof(v)));return v;}
static void nap(void){struct timespec t={0,100000};nanosleep(&t,NULL);}
static pw_ss_session *make(int role,unsigned frames){const uint16_t ops[]={1,2,3};pw_ss_session *s=NULL;assert(!pw_ss_create_v1(root,role,key,32,id,16,pw_ss_now_ns_v1()+10000000000ULL,ops,3,frames,&s));return s;}
static const unsigned char *outbound(pw_ss_session *s,size_t *n,uint64_t *token){const unsigned char *p;assert(!pw_ss_outbound_v1(s,&p,n,token));return p;}
static void record(const unsigned char *p,size_t n){if(transcript){unsigned char h[4]={(unsigned char)(n>>24),(unsigned char)(n>>16),(unsigned char)(n>>8),(unsigned char)n};assert(fwrite(h,1,4,transcript)==4&&fwrite(p,1,n,transcript)==n);}}
static pw_ss_event_v1 receive(pw_ss_session *s,const unsigned char *p,size_t n){pw_ss_event_v1 e;assert(!pw_ss_receive_v1(s,p,n,&e,sizeof(e)));return e;}
static pw_ss_event_v1 written(pw_ss_session *s,uint64_t token){pw_ss_event_v1 e;assert(!pw_ss_write_done_v1(s,token,1,&e,sizeof(e)));return e;}
static void ready(pw_ss_session **parent,pw_ss_session **child,unsigned frames){
    *parent=make(PW_SS_PARENT,frames);*child=make(PW_SS_CHILD,frames);
    size_t n;uint64_t pt,ct;const unsigned char *p=outbound(*parent,&n,&pt);record(p,n);receive(*child,p,n);
    p=outbound(*child,&n,&ct);record(p,n);assert(receive(*parent,p,n).event==PW_SS_NONE);
    assert(snapshot(*parent).phase==PW_SS_HELLO);assert(written(*child,ct).event==PW_SS_READY_EVENT);
    assert(written(*parent,pt).event==PW_SS_READY_EVENT);
}
static void roundtrip(pw_ss_session *parent,pw_ss_session *child,unsigned op,const unsigned char *payload,size_t size){
    assert(!pw_ss_request_v1(parent,op,payload,size));assert(pw_ss_request_v1(parent,op,payload,size)==PW_SS_BUSY);
    size_t n;uint64_t pt,ct;const unsigned char *p=outbound(parent,&n,&pt);record(p,n);pw_ss_event_v1 e=receive(child,p,n);
    assert(e.event==PW_SS_REQUEST_EVENT&&e.operation==op&&e.payload_bytes==size);
    assert(!pw_ss_respond_v1(child,e.payload,e.payload_bytes));p=outbound(child,&n,&ct);record(p,n);
    assert(receive(parent,p,n).event==PW_SS_NONE);written(child,ct);
    e=written(parent,pt);assert(e.event==PW_SS_RESPONSE_EVENT&&e.payload_bytes==size&&(!size||!memcmp(e.payload,payload,size)));
}
static void close_pair(pw_ss_session *parent,pw_ss_session *child){
    assert(!pw_ss_close_v1(parent));size_t n;uint64_t pt,ct;const unsigned char *p=outbound(parent,&n,&pt);record(p,n);receive(child,p,n);
    assert(!pw_ss_direct_exit_v1(parent));p=outbound(child,&n,&ct);record(p,n);
    assert(receive(parent,p,n).event==PW_SS_NONE);assert(!snapshot(parent).key_wiped);
    assert(written(child,ct).event==PW_SS_CLOSED_EVENT);assert(written(parent,pt).event==PW_SS_CLOSED_EVENT);
    assert(snapshot(parent).key_wiped&&snapshot(child).key_wiped);
    assert(pw_ss_request_v1(parent,1,NULL,0)==PW_SS_CLOSED);
}
static void fresh(void){offset_ns=0;expire_on_clock=0;expected_charge=0;root=pw_ss_root_create_v1();assert(root);}
static void done(void){assert(!pw_ss_root_destroy_v1(root));root=NULL;}
static void negative(const char *kind){
    fresh();pw_ss_session *a,*b;ready(&a,&b,64);size_t n;uint64_t pt,ct;
    unsigned char payload[]={1,2,3};assert(!pw_ss_request_v1(a,2,payload,3));const unsigned char *p=outbound(a,&n,&pt);
    pw_ss_event_v1 e=receive(b,p,n);assert(!pw_ss_respond_v1(b,e.payload,e.payload_bytes));p=outbound(b,&n,&ct);
    unsigned char bytes[256];assert(n<sizeof(bytes));memcpy(bytes,p,n);int expected=PW_SS_CORRELATION;
    if(!strcmp(kind,"mac")){bytes[n-1]^=1;expected=PW_SS_MAC;}
    else {
        if(!strcmp(kind,"direction")){bytes[5]=1;expected=PW_SS_DOMAIN;}
        else if(!strcmp(kind,"session")){bytes[18]^=1;expected=PW_SS_DOMAIN;}
        else if(!strcmp(kind,"sequence")){bytes[11]--;expected=PW_SS_SEQUENCE;}
        else if(!strcmp(kind,"request"))bytes[15]++;
        else if(!strcmp(kind,"operation"))bytes[17]++;
        else if(!strcmp(kind,"binding"))bytes[34]^=1;
        else if(!strcmp(kind,"type")){bytes[6]=3;expected=PW_SS_UNEXPECTED_MESSAGE;}
        CCHmac(kCCHmacAlgSHA256,key,32,bytes,n-32,bytes+n-32);
    }
    assert(pw_ss_receive_v1(a,bytes,n,&e,sizeof(e))==expected&&e.event==PW_SS_NONE&&!e.payload);
    assert(snapshot(a).key_wiped);assert(pw_ss_receive_v1(a,p,n,&e,sizeof(e))==expected);
    assert(pw_ss_write_done_v1(a,pt,1,&e,sizeof(e))==expected);assert(pw_ss_request_v1(a,1,NULL,0)==expected);done();
}
static void *wrong_thread(void *s){assert(pw_ss_abort_v1(s)==PW_SS_OWNER);return NULL;}
static void assert_dead(pw_ss_session *s,int code){
    pw_ss_snapshot_v1 before=snapshot(s);assert(before.key_wiped&&!before.execution_authorized&&!before.os_identity&&!before.tree_exit_proven&&!before.watchdog);
    pw_ss_event_v1 e;const unsigned char *p=(void *)1;size_t n=1;uint64_t token=1;
    assert(pw_ss_tick_v1(s)==code && pw_ss_abort_v1(s)==code && pw_ss_eof_v1(s)==code);
    assert(pw_ss_outbound_v1(s,&p,&n,&token)==code&&!p&&!n&&!token);
    assert(pw_ss_receive_v1(s,NULL,0,&e,sizeof(e))==code&&!e.payload&&e.event==PW_SS_NONE);
    assert(pw_ss_write_done_v1(s,1,1,&e,sizeof(e))==code);
    assert(pw_ss_request_v1(s,1,NULL,0)==code && pw_ss_respond_v1(s,NULL,0)==code && pw_ss_close_v1(s)==code);
    pw_ss_snapshot_v1 after=snapshot(s);assert(!memcmp(&before,&after,sizeof(before)));
}
static void allocations(void){
    fresh();size_t baseline=snapshot(NULL).capacity_reserved;fail_calloc=1;
    const uint16_t ops[]={1};pw_ss_session *s=(void *)1;
    assert(pw_ss_create_v1(root,PW_SS_CHILD,key,32,id,16,pw_ss_now_ns_v1()+1000000000ULL,ops,1,64,&s)==PW_SS_SYSTEM&&!s);
    assert(snapshot(NULL).capacity_reserved>baseline && snapshot(NULL).sessions_retained==1);fail_calloc=0;done();
    for(unsigned which=0;which<2;which++){
        fresh();baseline=snapshot(NULL).capacity_reserved;fail_wire_calloc=which==0;fail_wire_malloc=which==1;
        assert(pw_ss_create_v1(root,PW_SS_PARENT,key,32,id,16,pw_ss_now_ns_v1()+1000000000ULL,ops,1,64,&s)==PW_SS_SYSTEM);
        assert(s && snapshot(s).capacity_reserved>baseline && snapshot(s).sent_reserved==130);assert_dead(s,PW_SS_SYSTEM);
        fail_wire_calloc=fail_wire_malloc=0;done();
    }
    fresh();pw_ss_session *a,*b;ready(&a,&b,64);unsigned char bytes[]={0,255,9};
    assert(!pw_ss_request_v1(a,1,bytes,sizeof(bytes)));size_t n;uint64_t pt,ct;
    const unsigned char *p=outbound(a,&n,&pt);pw_ss_event_v1 e=receive(b,p,n);assert(!pw_ss_respond_v1(b,e.payload,e.payload_bytes));
    p=outbound(b,&n,&ct);baseline=snapshot(a).capacity_reserved;expected_charge=baseline+sizeof(bytes);fail_malloc=1;
    assert(pw_ss_receive_v1(a,p,n,&e,sizeof(e))==PW_SS_SYSTEM&&!e.payload&&e.event==PW_SS_NONE);
    assert(snapshot(a).capacity_reserved==expected_charge);assert_dead(a,PW_SS_SYSTEM);fail_malloc=0;expected_charge=0;done();
    printf("{\"status\":\"OK\",\"allocationFailures\":4,\"prechargedAllocations\":%u}\n",charged_allocations);
}
static void resign(unsigned char *p,size_t n){CCHmac(kCCHmacAlgSHA256,key,32,p,n-32,p+n-32);}
static void handshake_negative(void){
    // Both incoming HELLO and incoming HELLO_ACK must reject each handshake
    // field independently, even with a correct MAC and expected sequence.
    for(unsigned target=0;target<2;target++)for(unsigned change=0;change<6;change++){
        fresh();pw_ss_session *a=make(PW_SS_PARENT,64),*b=make(PW_SS_CHILD,64);size_t n;uint64_t token;
        const unsigned char *p=outbound(a,&n,&token);
        if(target){receive(b,p,n);p=outbound(b,&n,&token);}
        unsigned char bytes[131];assert(n==130);memcpy(bytes,p,n);
        size_t positions[]={6,15,17,34,66,65};bytes[positions[change]]^=1;
        if(change==5){ // challenge length 31, with all framing and MAC valid
            memmove(bytes+97,bytes+98,32);n--;bytes[3]--;}
        // A child accepts ANY 32-byte random challenge, including changed
        // content; use nonzero binding for its content case instead.
        if(!target&&change==4)bytes[34]^=1;
        resign(bytes,n);pw_ss_event_v1 e;
        assert(pw_ss_receive_v1(target?a:b,bytes,n,&e,sizeof(e))==PW_SS_HANDSHAKE);
        assert_dead(target?a:b,PW_SS_HANDSHAKE);done();
    }
    fresh();pw_ss_session *a=make(PW_SS_PARENT,64),*b=make(PW_SS_CHILD,64);size_t n;uint64_t pt,ct;
    const unsigned char *p=outbound(a,&n,&pt);receive(b,p,n);p=outbound(b,&n,&ct);receive(a,p,n);
    unsigned char bytes[130];memcpy(bytes,p,n);bytes[11]++;resign(bytes,n);
    pw_ss_event_v1 e;assert(pw_ss_receive_v1(a,bytes,n,&e,sizeof(e))==PW_SS_HANDSHAKE);assert_dead(a,PW_SS_HANDSHAKE);done();
    puts("{\"status\":\"OK\",\"handshakeCases\":13}");
}
static void replay_and_close(void){
    fresh();pw_ss_session *a,*b;ready(&a,&b,64);assert(!pw_ss_request_v1(a,1,NULL,0));size_t n;uint64_t pt,ct;
    const unsigned char *p=outbound(a,&n,&pt);pw_ss_event_v1 e=receive(b,p,n);assert(!pw_ss_respond_v1(b,e.payload,e.payload_bytes));
    p=outbound(b,&n,&ct);unsigned char bytes[256];memcpy(bytes,p,n);receive(a,p,n);
    bytes[11]++;resign(bytes,n);assert(pw_ss_receive_v1(a,bytes,n,&e,sizeof(e))==PW_SS_CORRELATION);assert_dead(a,PW_SS_CORRELATION);done();
    fresh();ready(&a,&b,64);assert(!pw_ss_request_v1(a,1,NULL,0));p=outbound(a,&n,&pt);memcpy(bytes,p,n);receive(b,p,n);
    bytes[11]++;bytes[15]++;resign(bytes,n);assert(pw_ss_receive_v1(b,bytes,n,&e,sizeof(e))==PW_SS_UNEXPECTED_MESSAGE);assert_dead(b,PW_SS_UNEXPECTED_MESSAGE);done();
    for(unsigned change=0;change<5;change++){
        fresh();ready(&a,&b,64);assert(!pw_ss_close_v1(a));p=outbound(a,&n,&pt);receive(b,p,n);p=outbound(b,&n,&ct);memcpy(bytes,p,n);
        size_t positions[]={15,17,34,6};int code=PW_SS_CORRELATION;
        if(change<4){bytes[positions[change]]^=1;if(change==3)code=PW_SS_UNEXPECTED_MESSAGE;}
        else {memmove(bytes+67,bytes+66,32);bytes[66]=1;n++;bytes[3]++;code=PW_SS_UNEXPECTED_MESSAGE;}
        resign(bytes,n);assert(pw_ss_receive_v1(a,bytes,n,&e,sizeof(e))==code);assert_dead(a,code);done();
    }
    fresh();ready(&a,&b,64);assert(!pw_ss_close_v1(a));p=outbound(a,&n,&pt);receive(b,p,n);p=outbound(b,&n,&ct);receive(a,p,n);
    assert(pw_ss_write_done_v1(a,pt,0,&e,sizeof(e))==PW_SS_WRITE);assert_dead(a,PW_SS_WRITE);done();
    fresh();ready(&a,&b,64);assert(!pw_ss_close_v1(a));p=outbound(a,&n,&pt);receive(b,p,n);outbound(b,&n,&ct);
    assert(pw_ss_write_done_v1(b,ct,0,&e,sizeof(e))==PW_SS_WRITE);assert_dead(b,PW_SS_WRITE);done();
    puts("{\"status\":\"OK\",\"replayAndCloseCases\":9}");
}
static void boundaries(void){
    // Exact complete-frame maximum in BOTH directions and both completion
    // orders. No one-MiB stack objects; fixture buffers are explicitly outside
    // the state ledger, like a transport-owned immutable incoming frame.
    fresh();pw_ss_session *a,*b;ready(&a,&b,64);
    unsigned char *max=malloc(PW_SW_MAX_PAYLOAD);assert(max);memset(max,0x5a,PW_SW_MAX_PAYLOAD);
    pw_ss_snapshot_v1 before=snapshot(a);
    assert(pw_ss_request_v1(a,2,max,PW_SW_MAX_PAYLOAD+1)==PW_SS_SIZE);
    assert(pw_ss_request_v1(a,UINT64_MAX,NULL,0)==PW_SS_OPERATION);
    pw_ss_snapshot_v1 after=snapshot(a);assert(!memcmp(&before,&after,sizeof(before)));
    assert(!pw_ss_request_v1(a,2,max,PW_SW_MAX_PAYLOAD));size_t n;uint64_t pt,ct;
    const unsigned char *p=outbound(a,&n,&pt);assert(n==1048697);record(p,n);
    pw_ss_event_v1 e=receive(b,p,n);assert(e.payload_bytes==PW_SW_MAX_PAYLOAD);
    // A real receiver owns its frame independently of the sender. This
    // in-process fixture must use its retained payload copy after sender free.
    written(a,pt);assert(!pw_ss_respond_v1(b,max,PW_SW_MAX_PAYLOAD));p=outbound(b,&n,&ct);assert(n==1048697);
    e=receive(a,p,n);assert(e.event==PW_SS_RESPONSE_EVENT&&e.payload_bytes==PW_SW_MAX_PAYLOAD&&!memcmp(e.payload,max,PW_SW_MAX_PAYLOAD));written(b,ct);
    close_pair(a,b);assert_dead(a,PW_SS_CLOSED);assert_dead(b,PW_SS_CLOSED);done();
    for(unsigned mode=0;mode<4;mode++){
        fresh();ready(&a,&b,64);assert(!pw_ss_request_v1(a,2,max,PW_SW_MAX_PAYLOAD));p=outbound(a,&n,&pt);
        size_t invalid=mode==0?0:mode==1?97:mode==2?n-1:n+1;
        assert(pw_ss_receive_v1(b,p,invalid,&e,sizeof(e))==PW_SS_SIZE);assert_dead(b,PW_SS_SIZE);done();
    }
    fresh();ready(&a,&b,64);assert(!pw_ss_request_v1(a,2,max,3));p=outbound(a,&n,&pt);receive(b,p,n);
    assert(pw_ss_respond_v1(b,max,PW_SW_MAX_PAYLOAD+1)==PW_SS_SIZE);assert_dead(b,PW_SS_SIZE);done();
    // The shared root's cumulative direction quota, not wire's per-budget
    // 16-encoding limit, determines when repeated maximum frames are refused.
    fresh();ready(&a,&b,64);unsigned rounds=0;
    for(;;){int rc=pw_ss_request_v1(a,2,max,PW_SW_MAX_PAYLOAD);
        if(rc){assert(rc==PW_SS_BUDGET);assert_dead(a,PW_SS_BUDGET);break;}
        p=outbound(a,&n,&pt);e=receive(b,p,n);written(a,pt);
        rc=pw_ss_respond_v1(b,max,PW_SW_MAX_PAYLOAD);
        if(rc){assert(rc==PW_SS_BUDGET);assert_dead(b,PW_SS_BUDGET);break;}
        p=outbound(b,&n,&ct);e=receive(a,p,n);written(b,ct);assert(e.event==PW_SS_RESPONSE_EVENT);rounds++;
    }
    assert(rounds==3);pw_ss_snapshot_v1 retained=snapshot(NULL);assert(retained.sent_reserved<=PW_SS_BYTE_LIMIT);done();
    // Session admissions remain consumed after abort, including attempted
    // allocation failure. Creating another root is explicitly another ledger.
    fresh();for(unsigned i=0;i<PW_SS_MAX_SESSIONS;i++){a=make(PW_SS_CHILD,64);assert(pw_ss_abort_v1(a)==PW_SS_ABORTED);assert_dead(a,PW_SS_ABORTED);}
    const uint16_t ops[]={1};a=(void *)1;assert(pw_ss_create_v1(root,PW_SS_CHILD,key,32,id,16,pw_ss_now_ns_v1()+1000000000ULL,ops,1,64,&a)==PW_SS_ADMISSION&&!a);done();
    free(max);printf("{\"status\":\"OK\",\"maxFrameBytes\":1048697,\"cumulativeMaximumRounds\":%u,\"reservedBeforeFailure\":%zu}\n",rounds,retained.sent_reserved);
}
static void terminal_aliases(void){
    // Expire at receive entry, after verification, and after the result copy;
    // then fail result allocation and MAC verification on the same old-result
    // alias. Only fixture-owned independent frames may be reused after failure.
    const int codes[]={PW_SS_DEADLINE,PW_SS_DEADLINE,PW_SS_DEADLINE,PW_SS_SYSTEM,PW_SS_MAC};
    const unsigned char payload[]={0,255,7};
    for(unsigned mode=0;mode<sizeof(codes)/sizeof(codes[0]);mode++){
        fresh();pw_ss_session *a,*b;ready(&a,&b,64);
        pw_sw_budget *vectors=pw_sw_budget_create_v1();assert(vectors);
        pw_sw_fields_v1 f={0};f.direction=1;f.type=3;f.seq=3;f.request_id=2;f.operation=1;memcpy(f.session,id,16);
        pw_sw_frame *request;assert(!pw_sw_encode_v1(vectors,key,32,&f,sizeof(f),NULL,0,&request));
        size_t n;const unsigned char *p=pw_sw_frame_view_v1(request,&n);
        unsigned char digest[32];assert(CC_SHA256(p,(CC_LONG)n,digest));
        f.direction=2;f.type=4;memcpy(f.binding,digest,32);pw_sw_frame *response;
        assert(!pw_sw_encode_v1(vectors,key,32,&f,sizeof(f),payload,sizeof(payload),&response));
        size_t valid_size;const unsigned char *valid=pw_sw_frame_view_v1(response,&valid_size);
        unsigned char embedded[PW_SW_OVERHEAD+sizeof(payload)];assert(valid_size==sizeof(embedded));
        memcpy(embedded,valid,valid_size);if(mode==4)embedded[valid_size-1]^=1;
        // The outer first response is valid even when its opaque payload holds
        // an invalid next-frame MAC. Its copied result owns the future input.
        assert(!pw_ss_request_v1(a,1,NULL,0));uint64_t pt,ct;
        p=outbound(a,&n,&pt);receive(b,p,n);
        assert(!pw_ss_respond_v1(b,embedded,sizeof(embedded)));p=outbound(b,&n,&ct);receive(a,p,n);
        pw_ss_event_v1 e=written(a,pt);written(b,ct);
        assert(e.event==PW_SS_RESPONSE_EVENT&&e.payload_bytes==sizeof(embedded)&&!memcmp(e.payload,embedded,sizeof(embedded)));
        const unsigned char *aliased=e.payload;size_t aliased_size=e.payload_bytes;
        assert(!pw_ss_request_v1(a,1,NULL,0));p=outbound(a,&n,&pt);receive(b,p,n);
        pw_ss_snapshot_v1 before=snapshot(a);assert(before.phase==PW_SS_READY&&!before.key_wiped);
        unsigned allocation_count=charged_allocations;
        if(mode<3)expire_on_clock=mode+1;
        if(mode==3){fail_malloc=1;expected_charge=before.capacity_reserved+sizeof(payload);}
        memset(&e,0xa5,sizeof(e));
        int rc=pw_ss_receive_v1(a,aliased,aliased_size,&e,sizeof(e));
        // aliased and the prior result event are invalid now: do not read,
        // compare, free or resubmit either borrowed pointer after this call.
        aliased=NULL;
        assert(!expire_on_clock);offset_ns=0;fail_malloc=0;expected_charge=0;
        assert(rc==codes[mode]&&e.event==PW_SS_NONE&&!e.payload&&!e.payload_bytes);
        pw_ss_snapshot_v1 failed=snapshot(a);
        assert(failed.phase==PW_SS_FAILED&&failed.terminal_code==codes[mode]&&failed.key_wiped&&!failed.session_key_holder);
        size_t allocation=mode==2||mode==3;
        assert(charged_allocations==allocation_count+allocation);
        assert(failed.capacity_reserved==before.capacity_reserved+allocation*sizeof(payload));
        assert(failed.received_charged==before.received_charged+(mode?aliased_size:0));
        assert_dead(a,codes[mode]);
        // Restore the clock/allocator and offer an independently owned VALID
        // response plus the real late completion token; neither may revive it.
        assert(pw_ss_receive_v1(a,valid,valid_size,&e,sizeof(e))==codes[mode]&&e.event==PW_SS_NONE&&!e.payload);
        assert(pw_ss_write_done_v1(a,pt,1,&e,sizeof(e))==codes[mode]&&e.event==PW_SS_NONE&&!e.payload);
        pw_ss_snapshot_v1 after=snapshot(a);assert(!memcmp(&failed,&after,sizeof(failed)));
        assert(!pw_sw_budget_destroy_v1(vectors));done();
    }
}
static void ownership(void){
    fresh();pw_ss_session *a,*b;ready(&a,&b,64);
    const unsigned char expected[]={0,255,7};unsigned char *caller=malloc(3);assert(caller);memcpy(caller,expected,3);
    assert(!pw_ss_request_v1(a,1,caller,3));memset(caller,0,3);free(caller);
    size_t n;uint64_t pt,ct;const unsigned char *p=outbound(a,&n,&pt);
    // Transport receiver owns a separate immutable frame. Its REQUEST_EVENT
    // view remains usable even after the SENDER frees its outbound encoding.
    unsigned char *incoming=malloc(n);assert(incoming);memcpy(incoming,p,n);
    pw_ss_event_v1 e=receive(b,incoming,n);assert(!memcmp(e.payload,expected,3));written(a,pt);
    assert(!pw_ss_respond_v1(b,e.payload,e.payload_bytes));memset(incoming,0,n);free(incoming);
    p=outbound(b,&n,&ct);e=receive(a,p,n);assert(e.event==PW_SS_RESPONSE_EVENT&&!memcmp(e.payload,expected,3));written(b,ct);
    assert(!memcmp(e.payload,expected,3));close_pair(a,b);done();
    // A valid next response can be embedded in the previous result. Caller is
    // allowed to hand that immutable view back as input: state must copy BEFORE
    // releasing its old result, not free the storage backing m.payload first.
    fresh();ready(&a,&b,64);pw_sw_budget *vectors=pw_sw_budget_create_v1();assert(vectors);
    pw_sw_fields_v1 f={0};f.direction=1;f.type=3;f.seq=3;f.request_id=2;f.operation=1;memcpy(f.session,id,16);
    pw_sw_frame *future_request;assert(!pw_sw_encode_v1(vectors,key,32,&f,sizeof(f),NULL,0,&future_request));
    size_t qn;const unsigned char *q=pw_sw_frame_view_v1(future_request,&qn);unsigned char digest[32];assert(CC_SHA256(q,(CC_LONG)qn,digest));
    f.direction=2;f.type=4;memcpy(f.binding,digest,32);pw_sw_frame *future_reply;
    assert(!pw_sw_encode_v1(vectors,key,32,&f,sizeof(f),expected,3,&future_reply));
    const unsigned char *future=pw_sw_frame_view_v1(future_reply,&qn);
    assert(!pw_ss_request_v1(a,1,NULL,0));p=outbound(a,&n,&pt);receive(b,p,n);
    assert(!pw_ss_respond_v1(b,future,qn));p=outbound(b,&n,&ct);receive(a,p,n);e=written(a,pt);written(b,ct);
    const unsigned char *aliased=e.payload;size_t aliased_size=e.payload_bytes;assert(!memcmp(aliased,future,qn));
    assert(!pw_ss_request_v1(a,1,NULL,0));p=outbound(a,&n,&pt);receive(b,p,n);written(a,pt);
    assert(!pw_ss_respond_v1(b,expected,3));p=outbound(b,&n,&ct);assert(n==aliased_size&&!memcmp(p,aliased,n));
    e=receive(a,aliased,aliased_size);assert(e.event==PW_SS_RESPONSE_EVENT&&e.payload_bytes==3&&!memcmp(e.payload,expected,3));
    written(b,ct);close_pair(a,b);assert(!pw_sw_budget_destroy_v1(vectors));done();
    terminal_aliases();
    puts("{\"status\":\"OK\",\"ownershipCases\":2,\"terminalAliasCases\":5}");
}
static void selftest(void){
    for(unsigned i=0;i<8;i++){const char *names[]={"mac","direction","session","sequence","request","operation","binding","type"};negative(names[i]);}
    fresh();pw_ss_session *a,*b;ready(&a,&b,64);
    for(unsigned i=0;i<32;i++){unsigned char p[]={0,255,(unsigned char)i};roundtrip(a,b,i%3+1,p,3);}close_pair(a,b);done();
    fresh();ready(&a,&b,64);unsigned char *max=malloc(PW_SW_MAX_PAYLOAD);assert(max);memset(max,0x7b,PW_SW_MAX_PAYLOAD);
    roundtrip(a,b,2,max,PW_SW_MAX_PAYLOAD);close_pair(a,b);free(max);done();
    fresh();ready(&a,&b,64);assert(pw_ss_request_v1(a,9,NULL,0)==PW_SS_OPERATION);assert(!snapshot(a).key_wiped);
    assert(pw_ss_request_v1(a,1,(const unsigned char *)"x",PW_SW_MAX_PAYLOAD+1)==PW_SS_SIZE);
    pthread_t thread;assert(!pthread_create(&thread,NULL,wrong_thread,a));assert(!pthread_join(thread,NULL));
    offset_ns=20000000000LL;assert(pw_ss_tick_v1(a)==PW_SS_DEADLINE&&snapshot(a).key_wiped);offset_ns=0;assert(pw_ss_tick_v1(a)==PW_SS_DEADLINE);done();
    fresh();ready(&a,&b,64);assert(!pw_ss_request_v1(a,1,NULL,0));size_t n;uint64_t token;outbound(a,&n,&token);
    pw_ss_event_v1 e;assert(pw_ss_write_done_v1(a,token+1,1,&e,sizeof(e))==PW_SS_TOKEN&&snapshot(a).key_wiped);done();
    fresh();ready(&a,&b,64);assert(pw_ss_eof_v1(a)==PW_SS_DISCONNECTED&&snapshot(a).key_wiped);done();
    fresh();ready(&a,&b,64);assert(pw_ss_direct_exit_v1(a)==PW_SS_DIRECT_EXIT&&snapshot(a).key_wiped);done();
    fresh();ready(&a,&b,1);assert(pw_ss_request_v1(a,1,NULL,0)==PW_SS_FRAME_LIMIT&&snapshot(a).key_wiped);done();
    fresh();ready(&a,&b,64);assert(!pw_ss_request_v1(a,1,NULL,0));const unsigned char *p=outbound(a,&n,&token);e=receive(b,p,n);assert(!pw_ss_respond_v1(b,e.payload,e.payload_bytes));p=outbound(b,&n,&token);
    fail_malloc=1;assert(pw_ss_receive_v1(a,p,n,&e,sizeof(e))==0); // empty response needs no allocation
    fail_malloc=0;assert(pw_ss_abort_v1(a)==PW_SS_ABORTED&&snapshot(a).key_wiped);done();
    puts("{\"status\":\"OK\",\"selftest\":true}");
}
static int io(int fd,unsigned char *p,size_t n,int writing){size_t used=0;uint64_t until=pw_ss_now_ns_v1()+10000000000ULL;while(used<n&&pw_ss_now_ns_v1()<until){size_t credit=n-used;if(credit>4096)credit=4096;ssize_t done=writing?write(fd,p+used,credit):read(fd,p+used,credit);if(done>0)used+=(size_t)done;else if(done<0&&(errno==EAGAIN||errno==EINTR))nap();else return 0;}return used==n;}
static void live(int native_role){
    int request[2],response[2];assert(!pipe2(request,O_CLOEXEC|O_NONBLOCK)&&!pipe2(response,O_CLOEXEC|O_NONBLOCK));
    posix_spawn_file_actions_t actions;posix_spawnattr_t attr;assert(!posix_spawn_file_actions_init(&actions)&&!posix_spawnattr_init(&attr));
    assert(!posix_spawnattr_setflags(&attr,POSIX_SPAWN_CLOEXEC_DEFAULT));
    int child_read=fcntl(request[0],F_DUPFD_CLOEXEC,16),child_write=fcntl(response[1],F_DUPFD_CLOEXEC,16);assert(child_read>=0&&child_write>=0);
    assert(!posix_spawn_file_actions_adddup2(&actions,child_read,3)&&!posix_spawn_file_actions_adddup2(&actions,child_write,4));
    assert(!posix_spawn_file_actions_addclose(&actions,child_read)&&!posix_spawn_file_actions_addclose(&actions,child_write));
    char *const args[]={(char *)PW_SS_NODE,(char *)PW_SS_JS_PEER,(char *)(native_role==PW_SS_PARENT?"child":"parent"),NULL};char *const env[]={(char *)"PATH=/usr/bin:/bin",NULL};pid_t pid;
    assert(!posix_spawn(&pid,PW_SS_NODE,&actions,&attr,args,env));posix_spawn_file_actions_destroy(&actions);posix_spawnattr_destroy(&attr);
    close(child_read);close(child_write);close(request[0]);close(response[1]);assert(!fcntl(request[1],F_SETNOSIGPIPE,1));
    fresh();pw_ss_session *s=make(native_role,64);unsigned rounds=0;int closing=0,awaiting=0;
    for(;;){
        const unsigned char *wire;size_t n;uint64_t token;int rc=pw_ss_outbound_v1(s,&wire,&n,&token);
        if(!rc){assert(io(request[1],(unsigned char *)wire,n,1));pw_ss_event_v1 e=written(s,token);if(e.event==PW_SS_CLOSED_EVENT)break;}
        if(snapshot(s).phase==PW_SS_READY&&native_role==PW_SS_PARENT&&!awaiting){
            if(rounds<12){unsigned char p[]={0,255,(unsigned char)rounds};assert(!pw_ss_request_v1(s,rounds%3+1,p,3));awaiting=1;}
            else {assert(!pw_ss_close_v1(s));closing=1;}continue;
        }
        unsigned char header[4];assert(io(response[0],header,4,0));n=((size_t)header[0]<<24)|((size_t)header[1]<<16)|((size_t)header[2]<<8)|header[3];n+=4;assert(n>=98&&n<=PW_SW_MAX_FRAME);
        unsigned char *frame=malloc(n);assert(frame);memcpy(frame,header,4);assert(io(response[0],frame+4,n-4,0));pw_ss_event_v1 e=receive(s,frame,n);
        if(e.event==PW_SS_REQUEST_EVENT){assert(!pw_ss_respond_v1(s,e.payload,e.payload_bytes));rounds++;}
        if(e.event==PW_SS_RESPONSE_EVENT){assert(e.payload_bytes==3&&e.payload[0]==0&&e.payload[1]==255&&e.payload[2]==rounds);rounds++;awaiting=0;}
        if(e.event==PW_SS_CLOSED_EVENT){assert(closing);free(frame);break;}
        free(frame);
    }
    assert(rounds==12&&snapshot(s).key_wiped);close(request[1]);close(response[0]);int status;assert(waitpid(pid,&status,0)==pid&&WIFEXITED(status)&&!WEXITSTATUS(status));done();
    printf("{\"status\":\"OK\",\"rounds\":%u,\"nativeRole\":%d}\n",rounds,native_role);
}
int main(int argc,char **argv){assert(argc>=2);for(unsigned i=0;i<32;i++)key[i]=(unsigned char)i;for(unsigned i=0;i<16;i++)id[i]=(unsigned char)(16+i);
    if(!strcmp(argv[1],"selftest"))selftest();
    else if(!strcmp(argv[1],"allocations"))allocations();
    else if(!strcmp(argv[1],"handshake-negative"))handshake_negative();
    else if(!strcmp(argv[1],"replay-close"))replay_and_close();
    else if(!strcmp(argv[1],"boundaries"))boundaries();
    else if(!strcmp(argv[1],"ownership"))ownership();
    else if(!strcmp(argv[1],"live-parent"))live(PW_SS_PARENT);
    else if(!strcmp(argv[1],"live-child"))live(PW_SS_CHILD);
    else {assert(argc==3);transcript=fopen(argv[2],"wb");assert(transcript);fresh();pw_ss_session *a,*b;ready(&a,&b,64);for(unsigned i=0;i<3;i++){unsigned char p[]={0,255,(unsigned char)i};roundtrip(a,b,i+1,p,3);}close_pair(a,b);done();assert(!fclose(transcript));puts("{\"status\":\"OK\"}");}return 0;}
