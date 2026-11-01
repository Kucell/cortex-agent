#include "anonymous.h"
#ifdef PW_READINESS_TEST
void pw_readiness_bind(pw_root *,pw_session *,int);
#endif
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
static pw_root *root;
static int fail_allocation;
static size_t allocations;
static pw_snapshot_v2 snap(pw_session *s) { pw_snapshot_v2 v; assert(pw_inspect_v2(root,s,PW_SNAPSHOT_ABI_V2,sizeof(pw_snapshot_v2),&v)==PW_OK); return v; }
// Only core malloc is redirected. Observe capacity BEFORE the real allocator.
void *pw_capacity_malloc(size_t n) {
    pw_snapshot_v2 v=snap(NULL);
    allocations++;
    assert(v.capacity_bytes>=2*PW_V2_BODY_MAX+4);
    assert(v.allocation_attempts==allocations);
    if(fail_allocation && allocations==(size_t)fail_allocation) return NULL;
    return malloc(n);
}
static void nap(void) { struct timespec t={0,100000}; nanosleep(&t,NULL); }
static int handshake(pw_session *s) { int rc; do { rc=pw_handshake_step(s); if(rc==PW_AGAIN) nap(); }while(rc==PW_AGAIN);return rc; }
static int receive(pw_session *s,const unsigned char **p,size_t *n) { int rc; do{rc=pw_read_frame_step(s,p,n);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);return rc; }
static void send(pw_session *s,const unsigned char *p,size_t n) {
    assert(pw_write_frame_begin(s,p,n)==PW_OK); int rc;
    do{size_t before=snap(s).sent_bytes;rc=pw_write_step(s);assert(snap(s).sent_bytes-before<=PW_IO_QUANTUM);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);
    assert(rc==PW_OK);
}
static pw_session *start(void) {
    pw_session *s=NULL; assert(pw_start(root,pw_now_ns()+4900000000ULL,&s)==PW_OK);
    assert(handshake(s)==PW_OK);const unsigned char *p;size_t n;
    assert(receive(s,&p,&n)==PW_OK && n==5 && !memcmp(p,"FD_OK",5));return s;
}
static void finish(pw_session *s) {
    pw_snapshot_v2 before=snap(s);pw_cancel(s);
    if(before.launch_started) {
        assert(pw_terminate_direct_child(s)==PW_OK);int rc;uint64_t until=pw_now_ns()+1000000000ULL;
        do{rc=pw_observe_direct_exit(s);assert(pw_now_ns()<until);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);assert(rc==PW_OK);
    }
    pw_snapshot_v2 after=snap(s);
    assert(after.capacity_bytes==before.capacity_bytes && after.reserved_send_bytes==before.reserved_send_bytes);
    assert(!after.tree_exit_proven && after.charges_retained && !after.execution_authorized);
}
static void traces(void) {
    pw_snapshot_v2 v=snap(NULL);size_t received=0;
    for(size_t i=0;i<v.trace_count;i++) {
        pw_read_trace tr;assert(pw_trace_at(root,i,&tr)==PW_OK);
        assert(tr.credit && tr.credit<=PW_IO_QUANTUM && tr.credit<=tr.phase_remaining && tr.credit<=tr.total_remaining);
        assert(tr.reserved_before_read==tr.credit && tr.total_remaining==v.read_limit-received);
        if(tr.result>0){assert((size_t)tr.result<=tr.credit);received+=(size_t)tr.result;}
        printf("[%zu,%zu,%zu,%zu,%d]%s",tr.credit,tr.phase_remaining,tr.total_remaining,tr.reserved_before_read,tr.result,i+1==v.trace_count?"":",");
    }
    assert(received==v.received_bytes && !v.pending_read_bytes);
}
int main(int argc,char **argv) {
    assert(argc==2 && pw_platform_supported());
    root=pw_root_create_profile(PW_PROFILE_V2);assert(root);
    const char *mode=argv[1];
    if(!strcmp(mode,"default")) {
        pw_session *s=NULL; assert(pw_start(root,pw_now_ns()+1000000000ULL,&s)==PW_UNSAFE_DEPLOYMENT && !s);
        assert(snap(NULL).sessions==0);assert(pw_root_destroy(root)==PW_OK);puts("{\"status\":\"REFUSED\"}");return 0;
    }
    if(!strcmp(mode,"alloc-1")||!strcmp(mode,"alloc-2")) {
        fail_allocation=!strcmp(mode,"alloc-1")?1:2;pw_session *s;
        assert(pw_start(root,pw_now_ns()+1000000000ULL,&s)==PW_SYSTEM);
        assert(snap(s).capacity_bytes==2*PW_V2_BODY_MAX+4 && !snap(s).launch_started);finish(s);
    } else {
        pw_session *a=start(),*b=NULL;const unsigned char *p;size_t n;
        unsigned char command=4;
        if(!strcmp(mode,"oversize-read")) {command=3;send(a,&command,1);assert(receive(a,&p,&n)==PW_LENGTH);assert(snap(a).received_bytes==49);}
        else if(!strcmp(mode,"oversize-write")) {
            size_t before=snap(a).reserved_send_bytes;
            assert(pw_write_frame_begin(a,&command,PW_V2_BODY_MAX+1)==PW_LENGTH);assert(snap(a).reserved_send_bytes==before);
        } else if(!strcmp(mode,"trace")) {
#ifdef PW_READINESS_TEST
            pw_readiness_bind(root,a,1); // actual read EAGAIN with ready hint
#endif
            int rc;do{rc=pw_read_frame_step(a,&p,&n);}while(rc==PW_AGAIN);
            assert(rc==PW_TRACE_LIMIT && snap(a).trace_count==PW_V2_TRACE_MAX);
        } else if(!strcmp(mode,"send-frames")) {
            command=2;
            for(unsigned i=0;i<PW_FRAME_COUNT_MAX;i++) {
                send(a,&command,1); assert(receive(a,&p,&n)==PW_OK && n==1);
                // Incoming handshake/ready count too: this direction reaches
                // its independent frame bound first; stop two frames earlier.
                if(i==PW_FRAME_COUNT_MAX-3) break;
            }
            // Remaining two writes need no reads; peer buffering is bounded.
            send(a,&command,1);send(a,&command,1);
            assert(pw_write_frame_begin(a,&command,1)==PW_QUOTA);
            assert(snap(a).outgoing_frames==PW_FRAME_COUNT_MAX);
        } else if(!strcmp(mode,"frames")) {
            command=5;send(a,&command,1);int rc;
            do{rc=receive(a,&p,&n);}while(rc==PW_OK);
            assert(rc==PW_QUOTA && snap(a).incoming_frames==PW_FRAME_COUNT_MAX);
        } else if(!strcmp(mode,"cumulative-read")) {
            for(unsigned i=0;;i++) {
                assert(i<9);send(a,&command,1);int rc=receive(a,&p,&n);
                if(rc!=PW_OK) {assert(rc==PW_QUOTA && snap(a).received_bytes==PW_V2_TOTAL);break;}
                assert(n==PW_V2_BODY_MAX);
            }
        } else if(!strcmp(mode,"read-total")) {
            send(a,&command,1);assert(receive(a,&p,&n)==PW_QUOTA);assert(snap(a).received_bytes==snap(a).read_limit);
        } else if(!strcmp(mode,"capacity")) {
            pw_snapshot_v2 before=snap(a);assert(pw_start(root,pw_now_ns()+1000000000ULL,&b)==PW_ADMISSION);
            assert(snap(b).allocation_attempts==before.allocation_attempts && snap(b).capacity_bytes==before.capacity_bytes);
        } else {
            unsigned char *bytes=malloc(PW_V2_BODY_MAX);assert(bytes);memset(bytes,7,PW_V2_BODY_MAX);
            if(!strcmp(mode,"send-total")) {
                size_t before=snap(a).write_calls;assert(pw_write_frame_begin(a,bytes,PW_V2_BODY_MAX)==PW_QUOTA);
                assert(snap(a).write_calls==before && snap(a).reserved_send_bytes==56);
            } else if(!strcmp(mode,"shared-send-total")) {
                b=start();assert(pw_write_frame_begin(a,bytes,PW_V2_BODY_MAX)==PW_OK);
                pw_snapshot_v2 before=snap(b);assert(pw_write_frame_begin(b,bytes,PW_V2_BODY_MAX)==PW_QUOTA);
                assert(snap(b).sent_bytes==112 && snap(b).reserved_send_bytes==112+PW_V2_WIRE_MAX);
                assert(snap(b).write_calls==before.write_calls);
            } else {
                b=start();
                if(!strcmp(mode,"max-write")) {
                    assert(pw_write_frame_begin(a,bytes,PW_V2_BODY_MAX)==PW_OK);
                    assert(pw_write_frame_begin(b,bytes,PW_V2_BODY_MAX)==PW_OK);
                    int written[2]={0,0};pw_session *writers[2]={a,b};size_t progress[2]={0,0};
                    while(!written[0]||!written[1]) {
                        for(int i=0;i<2;i++) if(!written[i]) {
                            size_t before=snap(writers[i]).sent_bytes;int rc=pw_write_step(writers[i]);
                            size_t delta=snap(writers[i]).sent_bytes-before;assert(delta<=PW_IO_QUANTUM);
                            if(delta)progress[i]++;
                            if(rc==PW_OK)written[i]=1;else assert(rc==PW_AGAIN);
                        }
                        nap();
                    }
                    assert(progress[0]>250 && progress[1]>250);
                } else {
                    send(a,&command,1);
                    unsigned char other=!strcmp(mode,"mixed")?2:command;send(b,&other,1);
                }
                int done[2]={0,0};pw_session *sessions[2]={a,b};size_t ticks=0,progress[2]={0,0};
                while(!done[0]||!done[1]) {
                    assert(++ticks<100000);
                    for(int i=0;i<2;i++) if(!done[i]) {
                        pw_snapshot_v2 before=snap(sessions[i]);int rc=pw_read_frame_step(sessions[i],&p,&n);pw_snapshot_v2 after=snap(sessions[i]);
                        assert(after.received_bytes-before.received_bytes<=PW_IO_QUANTUM+4 && after.read_calls-before.read_calls<=2);
                        if(after.received_bytes>before.received_bytes)progress[i]++;
                        if(rc==PW_OK){
                            size_t expected=(!strcmp(mode,"mixed")&&i==1)?1:PW_V2_BODY_MAX;
                            assert(n==expected);for(size_t j=0;j<n;j++)assert(p[j]==(expected==1?2:!strcmp(mode,"max-write")?7:4));done[i]=1;
                            if(expected==1) {
                                assert(!done[0]); // the small peer completes while the large one is in flight
                                unsigned char another=2;send(b,&another,1);
                                assert(receive(b,&p,&n)==PW_OK && n==1 && *p==2);
                            }
                        }
                        else if(rc==PW_QUOTA && !strcmp(mode,"shared-read-total")) done[i]=2;
                        else assert(rc==PW_AGAIN);
                    }
                    nap();
                }
                assert(progress[0]>250);
                assert(!strcmp(mode,"mixed")?progress[1]>0:progress[1]>250);
                if(!strcmp(mode,"shared-read-total")) {
                    assert(done[0]+done[1]==3 && snap(a).received_bytes==snap(a).read_limit);
                } else {
                // Completion never closes the other direction: small round
                // trips still work after either maximum response completes.
                command=2;send(a,&command,1);assert(receive(a,&p,&n)==PW_OK && n==1 && *p==2);
                send(b,&command,1);assert(receive(b,&p,&n)==PW_OK && n==1 && *p==2);
                if(!strcmp(mode,"cumulative-send")) {
                    bytes[0]=6;
                    int refused=0;
                    for(unsigned i=0;i<9;i++) {
                        pw_session *writer=(i%2)?b:a;pw_snapshot_v2 before=snap(writer);
                        int rc=pw_write_frame_begin(writer,bytes,PW_V2_BODY_MAX);
                        if(rc!=PW_OK) {
                            assert(rc==PW_QUOTA);assert(snap(writer).write_calls==before.write_calls);
                            assert(snap(writer).reserved_send_bytes==before.reserved_send_bytes);refused=1;break;
                        }
                        do{rc=pw_write_step(writer);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);assert(rc==PW_OK);
                        assert(receive(writer,&p,&n)==PW_OK && n==1 && *p==6);
                    }
                    assert(refused);
                }
                }
            }
            free(bytes);
        }
        if(b)finish(b);finish(a);
    }
    pw_snapshot_v2 v=snap(NULL);
    printf("{\"status\":\"OK\",\"maxWireBytes\":%d,\"received\":%zu,\"reservedSend\":%zu,\"capacity\":%zu,\"rootCapacity\":%zu,\"traceCount\":%zu,\"readCredits\":[",PW_V2_WIRE_MAX,v.received_bytes,v.reserved_send_bytes,v.capacity_bytes,v.root_capacity_bytes,v.trace_count);
    traces();puts("]}");assert(pw_root_destroy(root)==PW_OK);return 0;
}
