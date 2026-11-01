#include "combined-session.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/wait.h>
static void nap(void){struct timespec t={0,100000};nanosleep(&t,NULL);}
static pw_cs_snapshot_v1 snapshot(pw_cs_session *s){pw_cs_snapshot_v1 v;assert(!pw_cs_inspect_v1(s,&v,sizeof(v)));return v;}
static pw_ss_event_v1 until_event(pw_cs_session *s,enum pw_ss_event expected){
    uint64_t end=pw_now_ns()+5000000000ULL;
    for(;;){pw_ss_event_v1 event;int rc=pw_cs_pump_v1(s,&event,sizeof(event));assert(rc==PW_CS_OK||rc==PW_CS_AGAIN);if(event.event==expected)return event;assert(pw_now_ns()<end);nap();}
}
static void reap(pw_cs_session *s){uint64_t end=pw_now_ns()+1000000000ULL;int rc;do{rc=pw_cs_observe_v1(s);assert(rc==PW_OK||rc==PW_AGAIN);assert(pw_now_ns()<end);if(rc==PW_AGAIN)nap();}while(rc==PW_AGAIN);assert(snapshot(s).transport.direct_exit_observed);}
static void trace(pw_cs_root *root,pw_cs_session *s){
    pw_cs_snapshot_v1 v=snapshot(s);size_t bytes=0;
    printf("\"readCredits\":[");
    for(size_t i=0;i<v.transport.trace_count;i++){
        pw_read_trace t;assert(pw_cs_trace_v1(root,i,&t)==PW_OK);
        assert(t.credit&&t.credit<=4096&&t.credit<=t.phase_remaining&&t.credit<=t.total_remaining&&t.reserved_before_read==t.credit);
        assert(t.total_remaining==v.transport.read_limit-bytes);if(t.result>0){assert((size_t)t.result<=t.credit);bytes+=(size_t)t.result;}
        printf("%s[%zu,%zu,%zu,%zu,%d]",i?",":"",t.credit,t.phase_remaining,t.total_remaining,t.reserved_before_read,t.result);
    }
    assert(bytes==v.transport.received_bytes);printf("]");
}
#ifdef PW_ANONYMOUS_STATE_FIXTURE
static int concurrent(pw_cs_root *root){
    pw_cs_session *sessions[2];unsigned stage[2]={0},rounds[2]={0},completed=0;
    size_t turns[2]={0};unsigned char *payload=malloc(PW_SW_MAX_PAYLOAD);assert(payload);memset(payload,19,PW_SW_MAX_PAYLOAD);
    uint64_t end=pw_now_ns()+4900000000ULL;
    for(size_t i=0;i<2;i++)assert(!pw_cs_start_v1(root,end,&sessions[i]));
    pw_cs_session *extra=(void *)1;assert(pw_cs_start_v1(root,end,&extra)==PW_CS_BUSY&&!extra);
    while(completed<2){
        for(size_t i=0;i<2;i++){
            if(stage[i]==3)continue;
            pw_cs_snapshot_v1 before=snapshot(sessions[i]);pw_ss_event_v1 event;
            int rc=pw_cs_pump_v1(sessions[i],&event,sizeof(event));assert(rc==PW_CS_OK||rc==PW_CS_AGAIN);turns[i]++;
            pw_cs_snapshot_v1 after=snapshot(sessions[i]);
            assert(after.transport.sent_bytes-before.transport.sent_bytes<=PW_IO_QUANTUM);
            assert(after.transport.received_bytes-before.transport.received_bytes<=PW_IO_QUANTUM+4);
            if(event.event==PW_SS_READY_EVENT){assert(!stage[i]);stage[i]=1;assert(!pw_cs_request_v1(sessions[i],1,payload,PW_SW_MAX_PAYLOAD));}
            if(event.event==PW_SS_RESPONSE_EVENT){
                assert(stage[i]==1&&event.payload_bytes==PW_SW_MAX_PAYLOAD&&!memcmp(event.payload,payload,PW_SW_MAX_PAYLOAD));
                if(++rounds[i]==3){assert(!pw_cs_close_v1(sessions[i]));stage[i]=2;}
                else assert(!pw_cs_request_v1(sessions[i],rounds[i]%3+1,payload,PW_SW_MAX_PAYLOAD));
            }
            if(event.event==PW_SS_CLOSED_EVENT){assert(stage[i]==2);stage[i]=3;completed++;}
        }
        assert(pw_now_ns()<end);nap();
    }
    free(payload);assert(rounds[0]==3&&rounds[1]==3);
    pw_cs_snapshot_v1 v=snapshot(sessions[0]);
    assert(v.transport.sessions==2&&v.state.sessions_retained==2);
    assert(v.transport.capacity_bytes==4*(size_t)PW_V2_WIRE_MAX);
    assert(v.transport.sent_bytes==v.state.sent_reserved+112);
    assert(v.transport.received_bytes==v.state.received_charged);
    for(size_t i=0;i<2;i++){
        assert(snapshot(sessions[i]).state.key_wiped);reap(sessions[i]);
        int status=snapshot(sessions[i]).transport.direct_exit_status;assert(WIFEXITED(status)&&WEXITSTATUS(status)==0);
        assert(snapshot(sessions[i]).transport.capacity_bytes==v.transport.capacity_bytes);
    }
    printf("{\"status\":\"OK\",\"sessions\":2,\"maxFrameResponses\":6,\"roundRobinTurns\":[%zu,%zu],\"transportBufferReservation\":%zu,\"stateCapacityReservation\":%zu,",turns[0],turns[1],v.transport.capacity_bytes,v.state.capacity_reserved);
    trace(root,sessions[0]);puts("}");assert(!pw_cs_root_destroy_v1(root));return 0;
}
#endif
int main(int argc,char **argv){
    assert(argc==2);const char *mode=argv[1];pw_cs_root *root=NULL;
    int rc=pw_cs_root_create_v1(&root);
    if(!strcmp(mode,"default")){assert(rc==PW_CS_REFUSED&&!root);puts("{\"status\":\"REFUSED\"}");return 0;}
    assert(rc==PW_CS_OK);
#ifdef PW_ANONYMOUS_STATE_FIXTURE
    if(!strcmp(mode,"concurrent"))return concurrent(root);
#endif
    pw_cs_session *s=NULL;uint64_t deadline=pw_now_ns()+(!strcmp(mode,"stall")?700000000ULL:4900000000ULL);
    assert(!pw_cs_start_v1(root,deadline,&s));
    if(!strcmp(mode,"bad-mac")){
        for(;;){pw_ss_event_v1 e;rc=pw_cs_pump_v1(s,&e,sizeof(e));if(rc!=PW_CS_OK&&rc!=PW_CS_AGAIN)break;nap();}
        assert(rc==PW_CS_PROTOCOL&&snapshot(s).state_error==PW_SS_MAC);
    }else{
        until_event(s,PW_SS_READY_EVENT);
        assert(snapshot(s).transport.key_wiped&&!snapshot(s).state.key_wiped&&!snapshot(s).transport.authenticated);
        if(!strcmp(mode,"oversize")){
            pw_cs_snapshot_v1 before=snapshot(s);unsigned char dummy=0;
            assert(pw_cs_request_v1(s,1,&dummy,(size_t)PW_SW_MAX_PAYLOAD+1)==PW_CS_PROTOCOL);
            pw_cs_snapshot_v1 after=snapshot(s);assert(after.state_error==PW_SS_SIZE);
            assert(after.transport.sent_bytes==before.transport.sent_bytes&&after.state.sent_reserved==before.state.sent_reserved);
        }else if(!strcmp(mode,"eof")||!strcmp(mode,"exit")){
#ifdef PW_ANONYMOUS_STATE_FIXTURE
            assert(!pw_cs_resume_fixture_v1(s));
#endif
            if(!strcmp(mode,"exit")){reap(s);assert(!snapshot(s).protocol_closed);}
            for(;;){pw_ss_event_v1 e;rc=pw_cs_pump_v1(s,&e,sizeof(e));if(rc!=PW_CS_OK&&rc!=PW_CS_AGAIN)break;nap();}
            assert(rc!=PW_CS_CLOSED&&!snapshot(s).protocol_closed);
            if(!strcmp(mode,"eof"))assert(snapshot(s).transport_error==PW_EOF&&!snapshot(s).transport.direct_exit_observed);
            else assert(snapshot(s).state_error==PW_SS_DIRECT_EXIT);
        }else{
            unsigned char *payload=malloc(PW_SW_MAX_PAYLOAD);assert(payload);memset(payload,7,PW_SW_MAX_PAYLOAD);
            unsigned rounds=!strcmp(mode,"normal")?12:1;
            for(unsigned round=0;round<rounds;round++){
                size_t size=!strcmp(mode,"normal")?127:PW_SW_MAX_PAYLOAD;
                assert(!pw_cs_request_v1(s,round%3+1,payload,size));
                int signalled=0;
                for(;;){
                    pw_cs_snapshot_v1 before=snapshot(s);pw_ss_event_v1 event;rc=pw_cs_pump_v1(s,&event,sizeof(event));pw_cs_snapshot_v1 after=snapshot(s);
                    assert(after.transport.sent_bytes-before.transport.sent_bytes<=PW_IO_QUANTUM);
                    assert(after.transport.received_bytes-before.transport.received_bytes<=PW_IO_QUANTUM+4);
#ifdef PW_ANONYMOUS_STATE_FIXTURE
                    if(!strcmp(mode,"paused")&&!signalled&&after.transport.write_waits){assert(after.transport.sent_bytes<after.transport.reserved_send_bytes);assert(!pw_cs_resume_fixture_v1(s));signalled=1;}
#endif
                    if(rc!=PW_CS_OK&&rc!=PW_CS_AGAIN){assert(!strcmp(mode,"stall"));break;}
                    if(event.event==PW_SS_RESPONSE_EVENT){assert(event.payload_bytes==size&&!memcmp(event.payload,payload,size));break;}
                    nap();
                }
                if(!strcmp(mode,"paused"))assert(signalled);
                if(!strcmp(mode,"stall")){assert(pw_now_ns()>=deadline&&!snapshot(s).protocol_closed);break;}
            }
            free(payload);
            if(strcmp(mode,"stall")){
                assert(!pw_cs_close_v1(s));
                if(!strcmp(mode,"close-eof")){
                    for(;;){pw_ss_event_v1 e;rc=pw_cs_pump_v1(s,&e,sizeof(e));assert(e.event!=PW_SS_CLOSED_EVENT);if(rc!=PW_CS_OK&&rc!=PW_CS_AGAIN)break;nap();}
                    assert(rc==PW_CS_TRANSPORT&&!snapshot(s).protocol_closed&&snapshot(s).state.key_wiped);
                }else{until_event(s,PW_SS_CLOSED_EVENT);assert(snapshot(s).protocol_closed);}
            }
        }
    }
    pw_cs_snapshot_v1 end=snapshot(s);assert(end.state.key_wiped&&end.transport.key_wiped&&!end.state.execution_authorized&&!end.state.tree_exit_proven);
    if(!end.protocol_closed){int error=end.error;assert(error);pw_ss_event_v1 e;assert(pw_cs_pump_v1(s,&e,sizeof(e))==error);assert(pw_cs_request_v1(s,1,NULL,0)==error);}
    if(end.protocol_closed){reap(s);int status=snapshot(s).transport.direct_exit_status;assert(WIFEXITED(status)&&WEXITSTATUS(status)==0);}
    else {if(!end.transport.direct_exit_observed)assert(!pw_cs_terminate_v1(s));reap(s);}
    pw_cs_snapshot_v1 reaped=snapshot(s);
    assert(reaped.transport.capacity_bytes==end.transport.capacity_bytes&&reaped.state.capacity_reserved==end.state.capacity_reserved);
    if(end.protocol_closed){assert(end.transport.sent_bytes==end.state.sent_reserved+56);assert(end.transport.received_bytes==end.state.received_charged);}
    printf("{\"status\":\"OK\",\"protocolClosed\":%s,\"maxWireBytes\":%d,\"writeWaits\":%u,\"transportBytesSent\":%zu,\"stateBytesSent\":%zu,\"transportBufferReservation\":%zu,\"traceAndRootReservation\":%zu,\"stateCapacityReservation\":%zu,\"rssMeasured\":false,\"treeExitProven\":false,",
        end.protocol_closed?"true":"false",PW_V2_WIRE_MAX,end.transport.write_waits,end.transport.sent_bytes,end.state.sent_reserved,end.transport.capacity_bytes,end.transport.root_capacity_bytes,end.state.capacity_reserved);
    trace(root,s);puts("}");assert(!pw_cs_root_destroy_v1(root));return 0;
}
