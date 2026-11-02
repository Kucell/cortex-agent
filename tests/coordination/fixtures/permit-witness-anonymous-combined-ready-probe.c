/* Diagnostic only: retain the legacy SMALL profile/peer and record the exact
 * failed stage, rather than treating an assertion's line as a return code. */
#include "anonymous.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
static void nap(void){struct timespec t={0,2000000};nanosleep(&t,NULL);}
static int controlled;
static unsigned acks;
/* Test-only fault holds FD_OK body after the second valid ACK. It changes no
 * production limit and demonstrates why ready's receive assertion can fail
 * with time and bytes still available. Natural-load runs use the real read. */
ssize_t pw_cs_ready_read(int fd,void *p,size_t n){
    if(controlled&&acks==2&&n==5){errno=EAGAIN;return -1;}
    ssize_t rc=read(fd,p,n);if(n==32&&rc==32)acks++;return rc;
}
static pw_snapshot_v2 inspect(pw_root *r,pw_session *s){pw_snapshot_v2 v;assert(!pw_inspect_v2(r,s,2,sizeof(v),&v));return v;}
static void point(pw_root *r,pw_session *s,unsigned child,const char *stage,int rc,uint64_t start,uint64_t deadline){
    pw_snapshot_v2 v=inspect(r,s);
    printf("{\"child\":%u,\"stage\":\"%s\",\"rc\":\"%s\",\"elapsedNs\":%llu,\"remainingNs\":%llu,\"traceCount\":%zu,\"traceLimit\":%zu,\"received\":%zu,\"terminal\":\"%s\",\"reaped\":%d}\n",
        child,stage,pw_result_name(rc),(unsigned long long)(pw_now_ns()-start),(unsigned long long)(deadline>pw_now_ns()?deadline-pw_now_ns():0),v.trace_count,v.trace_limit,v.received_bytes,pw_result_name(v.terminal),v.direct_exit_observed);
}
int main(int argc,char **argv){
    assert(argc==2);controlled=!strcmp(argv[1],"controlled");
    pw_root *r=pw_root_create();assert(r);pw_session *sessions[2]={0};int failure=0;const char *failed_stage="none";
    uint64_t start=pw_now_ns(),deadline=start+3000000000ULL;
    for(unsigned i=0;i<2;i++){
        int rc=pw_start(r,deadline,&sessions[i]);point(r,sessions[i],i,"start",rc,start,deadline);assert(!rc);
        do{rc=pw_handshake_step(sessions[i]);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);
        point(r,sessions[i],i,"handshake",rc,start,deadline);
        if(rc){failure=rc;failed_stage="handshake";break;}
        const unsigned char *p;size_t n;
        do{rc=pw_read_frame_step(sessions[i],&p,&n);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);
        point(r,sessions[i],i,"FD_OK",rc,start,deadline);
        if(rc){failure=rc;failed_stage="FD_OK";break;}
        assert(n==5&&!memcmp(p,"FD_OK",5));
    }
    pw_snapshot_v2 v=inspect(r,NULL);
    for(unsigned i=0;i<2;i++)if(sessions[i]){
        pw_cancel(sessions[i]);assert(!pw_terminate_direct_child(sessions[i]));
        int rc;do{rc=pw_observe_direct_exit(sessions[i]);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);assert(!rc);
    }
    printf("{\"result\":\"%s\",\"failedStage\":\"%s\",\"traceCount\":%zu,\"deadlineExpired\":%s}\n",pw_result_name(failure),failed_stage,v.trace_count,pw_now_ns()>=deadline?"true":"false");
    assert(!pw_root_destroy(r));return 0;
}
