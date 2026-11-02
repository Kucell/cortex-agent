#include "combined-session.h"
#include <assert.h>
#include <errno.h>
#include <signal.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#ifndef PW_CS_MODE
#define PW_CS_MODE "echo"
#endif
static volatile sig_atomic_t resumed;
static void resume(int signal){(void)signal;resumed=1;}
static void nap(void){struct timespec t={0,100000};nanosleep(&t,NULL);}
// Only the child transport object's write is redirected here. No API, key,
// path or handle is exported to a caller. One finite malformed ACK for testing.
ssize_t pw_cs_test_write(int fd,const void *data,size_t n){
    if(!strcmp(PW_CS_MODE,"close-eof")&&n>6&&((const unsigned char *)data)[6]==6){
        assert(!close(fd));errno=EPIPE;return -1;
    }
    if(!strcmp(PW_CS_MODE,"bad-mac")){
        unsigned char copy[PW_IO_QUANTUM];assert(n<=sizeof(copy));memcpy(copy,data,n);copy[n-1]^=1;
        return write(fd,copy,n);
    }
    return write(fd,data,n);
}
int main(void){
    struct sigaction action;memset(&action,0,sizeof(action));action.sa_handler=resume;sigemptyset(&action.sa_mask);assert(!sigaction(SIGUSR1,&action,NULL));
    pw_cs_root *root=NULL;pw_cs_session *s=NULL;assert(pw_cs_root_create_v1(&root)==PW_CS_OK);assert(pw_cs_accept_fixture_v1(root,&s)==PW_CS_OK);
    int held=0;
    for(;;){
        pw_ss_event_v1 event;int rc=pw_cs_pump_v1(s,&event,sizeof(event));
        if(rc!=PW_CS_OK&&rc!=PW_CS_AGAIN)break;
        if(event.event==PW_SS_READY_EVENT&&!held){
            held=1;
            if(!strcmp(PW_CS_MODE,"eof")||!strcmp(PW_CS_MODE,"exit")){
                while(!resumed)nap();pw_cs_abort_v1(s);
                // EOF test holds the direct process alive, isolating pipe EOF
                // from real wait. Parent terminates it after observing EOF.
                if(!strcmp(PW_CS_MODE,"eof"))for(;;)nap();
                break;
            }
            if(!strcmp(PW_CS_MODE,"paused")||!strcmp(PW_CS_MODE,"stall")) {
                uint64_t end=pw_now_ns()+4000000000ULL;
                while(!resumed&&pw_now_ns()<end)nap();
            }
        }
        if(event.event==PW_SS_REQUEST_EVENT){
            // Pump must not invalidate a borrowed REQUEST before respond's
            // synchronous copy. Exercise this with a maximum-sized view.
            pw_ss_event_v1 pending;assert(pw_cs_pump_v1(s,&pending,sizeof(pending))==PW_CS_BUSY);
            assert(pw_cs_respond_v1(s,event.payload,event.payload_bytes)==PW_CS_OK);
        }
        if(event.event==PW_SS_CLOSED_EVENT)break;
        nap();
    }
    pw_cs_snapshot_v1 v;assert(!pw_cs_inspect_v1(s,&v,sizeof(v)));
    assert(v.state.key_wiped&&v.transport.key_wiped&&!v.state.execution_authorized&&!v.state.tree_exit_proven);
    size_t received=0;
    for(size_t i=0;i<v.transport.trace_count;i++){
        pw_read_trace t;assert(!pw_cs_trace_v1(root,i,&t));
        assert(t.credit&&t.credit<=PW_IO_QUANTUM&&t.credit<=t.phase_remaining&&t.credit<=t.total_remaining&&t.credit==t.reserved_before_read);
        assert(t.total_remaining==v.transport.read_limit-received);
        if(t.result>0){assert((size_t)t.result<=t.credit);received+=(size_t)t.result;}
    }
    assert(received==v.transport.received_bytes);
    if(v.protocol_closed){assert(v.transport.received_bytes==v.state.received_charged+56);assert(v.transport.sent_bytes==v.state.sent_reserved);}
    assert(!pw_cs_root_destroy_v1(root));return 0;
}
