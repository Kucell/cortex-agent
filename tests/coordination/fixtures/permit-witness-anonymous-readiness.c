/* Native fixture syscall seams only, NEVER linked into ordinary builds.
 * Readiness races are explicit injected faults; natural idle uses real poll.
 * bind mode: 0 real, 1 read EAGAIN, 2 read EINTR, 3 poll EINTR,
 * 4 poll EIO, 5 POLLNVAL, 6 late poll result, 7 POLLERR + read EAGAIN,
 * 8 pure unknown, 9 mixed known/unknown, 10 real buffered HUP drain. */
#include "anonymous.h"
#include <assert.h>
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
static pw_root *ledger;
static pw_session *current;
static int fault;
static unsigned polls,reads,checked;
static unsigned buffered_hup_reads,hup_eof_reads;
static size_t hup_bytes;
static short last_revents;
static uint64_t late;
void pw_readiness_bind(pw_root *r,pw_session *s,int mode){ledger=r;current=s;fault=mode;}
static pw_snapshot_v2 snap(void){pw_snapshot_v2 v;assert(!pw_inspect_v2(ledger,current,2,sizeof(v),&v));return v;}
int pw_readiness_clock_gettime(clockid_t clock,struct timespec *out){int rc=clock_gettime(clock,out);if(!rc&&late){out->tv_sec=(time_t)(late/1000000000ULL);out->tv_nsec=(long)(late%1000000000ULL);}return rc;}
int pw_readiness_poll(struct pollfd *fds,nfds_t count,int timeout){
    assert(count==1&&timeout==0);polls++;
    if(fault==3||fault==4){errno=fault==3?EINTR:EIO;return -1;}
    if(fault==1||fault==2||fault==5||fault==7){fds[0].revents=fault==5?POLLNVAL:fault==7?POLLERR:POLLIN;return 1;}
    if(fault==8||fault==9){fds[0].revents=POLLPRI|(fault==9?(POLLIN|POLLHUP|POLLERR):0);return 1;}
    int rc=poll(fds,count,timeout);
    if(fault==10){
        // Wait for the real writer close before allowing the first read;
        // leave the actual buffered pipe bytes untouched during this barrier.
        if(rc>0&&!(fds[0].revents&POLLHUP)){fds[0].revents=0;return 0;}
        last_revents=fds[0].revents;
    }
    if(fault==6){struct timespec t;assert(!clock_gettime(CLOCK_MONOTONIC,&t));late=(uint64_t)t.tv_sec*1000000000ULL+t.tv_nsec+6000000000ULL;}
    return rc;
}
ssize_t pw_readiness_read(int fd,void *buffer,size_t count){
    reads++;
    if(ledger){
        pw_snapshot_v2 v=snap();pw_read_trace t;assert(v.trace_count&&v.pending_read_bytes==count);
        assert(!pw_trace_at(ledger,v.trace_count-1,&t));
        assert(t.credit==count&&t.reserved_before_read==count&&count<=PW_IO_QUANTUM&&count<=t.phase_remaining&&count<=t.total_remaining);checked++;
    }
    if(fault==1||fault==2||fault==7){errno=fault==2?EINTR:EAGAIN;return -1;}
    ssize_t rc=read(fd,buffer,count);
    if(fault==10){
        assert(last_revents&POLLHUP);
        if(rc>0){assert(last_revents&POLLIN);buffered_hup_reads++;hup_bytes+=(size_t)rc;}
        if(!rc){assert(hup_bytes==516&&buffered_hup_reads==2);hup_eof_reads++;}
    }
    return rc;
}
#ifdef PW_READINESS_HARNESS
static void nap(void){struct timespec t={0,1000000};nanosleep(&t,NULL);}
static void ready(pw_session *s){
    pw_readiness_bind(ledger,s,0);int rc;
    do{rc=pw_handshake_step(s);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);assert(!rc);
    const unsigned char *p;size_t n;
    do{rc=pw_read_frame_step(s,&p,&n);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);assert(!rc&&n==5&&!memcmp(p,"FD_OK",5));
}
static int receive(pw_session *s){const unsigned char *p;size_t n;int rc;do{rc=pw_read_frame_step(s,&p,&n);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);return rc;}
static void exchange(pw_session *s){unsigned char bytes[512]={7};assert(!pw_write_frame_begin(s,bytes,sizeof(bytes)));int rc;do{rc=pw_write_step(s);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);assert(!rc);}
static void finish(pw_session *s){pw_cancel(s);assert(!pw_terminate_direct_child(s));int rc;do{rc=pw_observe_direct_exit(s);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);assert(!rc);}
int main(int argc,char **argv){
    assert(argc==2);ledger=pw_root_create();assert(ledger);pw_session *sessions[2]={0};uint64_t deadline=pw_now_ns()+3000000000ULL;
    unsigned count=!strcmp(argv[1],"idle-two")?2:1;
    for(unsigned i=0;i<count;i++){assert(!pw_start(ledger,deadline,&sessions[i]));ready(sessions[i]);}
    pw_readiness_bind(ledger,sessions[0],0);size_t before=snap().trace_count;unsigned before_reads=reads;int rc=PW_OK;const unsigned char *p;size_t n;
    if(!strcmp(argv[1],"idle-two")){
        for(unsigned turn=0;turn<4*PW_TRACE_MAX;turn++)for(unsigned i=0;i<2;i++){
            pw_readiness_bind(ledger,sessions[i],0);assert(pw_read_frame_step(sessions[i],&p,&n)==PW_AGAIN);assert(snap().trace_count==before&&reads==before_reads);
        }
        pw_readiness_bind(ledger,sessions[0],0);exchange(sessions[0]);assert(receive(sessions[0])==PW_OK);
        pw_readiness_bind(ledger,sessions[1],0);exchange(sessions[1]);assert(receive(sessions[1])==PW_QUOTA&&snap().received_bytes==PW_READ_TOTAL);
    }else if(!strcmp(argv[1],"hup-drain")){
        pw_readiness_bind(ledger,sessions[0],10);exchange(sessions[0]);
        do{rc=pw_read_frame_step(sessions[0],&p,&n);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);
        assert(rc==PW_OK&&n==512&&p[0]==7);for(size_t i=1;i<n;i++)assert(!p[i]);
        assert(buffered_hup_reads==2&&hup_bytes==516&&!hup_eof_reads);
        assert(snap().trace_count==before+2&&snap().terminal==PW_OK);
        assert(pw_observe_direct_exit(sessions[0])==PW_AGAIN); // writer closed, child still alive
        rc=pw_read_frame_step(sessions[0],&p,&n);assert(rc==PW_EOF&&!p&&!n);
        assert(hup_eof_reads==1&&snap().trace_count==before+3&&snap().received_bytes==561);
        pw_read_trace t;assert(!pw_trace_at(ledger,before+2,&t)&&!t.result);
    }else{
        int mode=!strcmp(argv[1],"race")||!strcmp(argv[1],"trace-races")?1:!strcmp(argv[1],"read-eintr")?2:!strcmp(argv[1],"poll-eintr")?3:!strcmp(argv[1],"poll-system")?4:!strcmp(argv[1],"nval")?5:!strcmp(argv[1],"late")?6:!strcmp(argv[1],"unknown")?8:!strcmp(argv[1],"mixed-unknown")?9:7;
        pw_readiness_bind(ledger,sessions[0],mode);
        if(!strcmp(argv[1],"trace-races")){
            do{rc=pw_read_frame_step(sessions[0],&p,&n);}while(rc==PW_AGAIN);
            assert(rc==PW_TRACE_LIMIT&&snap().trace_count==PW_TRACE_MAX);
        }else{
            rc=pw_read_frame_step(sessions[0],&p,&n);
            int actual_read=mode==1||mode==2||mode==7;
            assert(snap().trace_count==before+(size_t)actual_read&&reads==before_reads+(unsigned)actual_read);
            assert(rc==(mode==4||mode==5||mode==8||mode==9?PW_SYSTEM:mode==6?PW_DEADLINE:PW_AGAIN));
            if(actual_read){pw_read_trace t;assert(!pw_trace_at(ledger,before,&t));assert(t.result==-(mode==2?EINTR:EAGAIN));}
            if(rc==PW_AGAIN){pw_readiness_bind(ledger,sessions[0],0);exchange(sessions[0]);assert(receive(sessions[0])==PW_OK);}
        }
    }
    pw_snapshot_v2 end=snap();assert(checked==reads&&end.trace_count==reads&&!end.pending_read_bytes);
    if(rc!=PW_OK&&rc!=PW_AGAIN)assert(pw_read_frame_step(sessions[0],&p,&n)==rc);
    for(unsigned i=0;i<count;i++)finish(sessions[i]);
    assert(snap().capacity_bytes==end.capacity_bytes&&snap().charges_retained&&!snap().tree_exit_proven);
    printf("{\"status\":\"OK\",\"mode\":\"%s\",\"polls\":%u,\"reads\":%u,\"checkedBeforeRead\":%u,\"traceBefore\":%zu,\"traceAfter\":%zu,\"bufferedHupReads\":%u,\"hupEofReads\":%u,\"terminal\":\"%s\"}\n",argv[1],polls,reads,checked,before,end.trace_count,buffered_hup_reads,hup_eof_reads,pw_result_name(end.terminal));
    assert(!pw_root_destroy(ledger));return 0;
}
#endif
