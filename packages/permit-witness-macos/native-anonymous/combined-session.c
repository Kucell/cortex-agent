#include "combined-session.h"
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#ifdef PW_ANONYMOUS_STATE_FIXTURE
#include "fixture-only.h"
#endif
struct pw_cs_session {
    struct pw_cs_root *root;
    pw_session *transport;
    pw_ss_session *state;
    uint64_t token;
    int role,bootstrap,writing,handling,error,transport_error,state_error,closed;
};
struct pw_cs_root {
    pthread_t owner;
    pw_root *transport;
    pw_ss_root *state;
    size_t admitted;
    pw_cs_session slots[PW_SESSION_MAX];
};
static int owned(pw_cs_root *r){return r&&pthread_equal(r->owner,pthread_self());}
static int latch(pw_cs_session *s,int error,int tr,int st) {
    if(s->closed)return PW_CS_CLOSED;
    if(!s->error){s->error=error;s->transport_error=tr;s->state_error=st;
        if(s->state)pw_ss_abort_v1(s->state);if(s->transport)pw_cancel(s->transport);}
    return s->error;
}
int pw_cs_root_create_v1(pw_cs_root **out) {
    if(!out)return PW_CS_INPUT;*out=NULL;
#ifndef PW_ANONYMOUS_STATE_FIXTURE
    return PW_CS_REFUSED;
#else
    if(!pw_platform_supported())return PW_CS_REFUSED;
    pw_cs_root *r=calloc(1,sizeof(*r));if(!r)return PW_CS_TRANSPORT;
    r->owner=pthread_self();r->transport=pw_root_create_profile(PW_PROFILE_STATE_V2);r->state=pw_ss_root_create_v1();
    if(!r->transport||!r->state){if(r->transport)pw_root_destroy(r->transport);if(r->state)pw_ss_root_destroy_v1(r->state);free(r);return PW_CS_TRANSPORT;}
    *out=r;return PW_CS_OK;
#endif
}
int pw_cs_start_v1(pw_cs_root *r,uint64_t deadline,pw_cs_session **out) {
    if(out)*out=NULL;if(!owned(r)||!out)return PW_CS_OWNER;
#ifndef PW_ANONYMOUS_STATE_FIXTURE
    (void)deadline;return PW_CS_REFUSED;
#else
    if(r->admitted==PW_SESSION_MAX)return PW_CS_BUSY;
    pw_cs_session *s=&r->slots[r->admitted++];s->root=r;s->role=PW_SS_PARENT;*out=s;
    int rc=pw_state_start_fixture_v1(r->transport,r->state,deadline,&s->transport,&s->state);
    return rc?latch(s,PW_CS_TRANSPORT,rc,0):PW_CS_OK;
#endif
}
#ifdef PW_ANONYMOUS_STATE_FIXTURE
int pw_cs_accept_fixture_v1(pw_cs_root *r,pw_cs_session **out) {
    if(out)*out=NULL;if(!owned(r)||!out)return PW_CS_OWNER;
    if(r->admitted)return PW_CS_BUSY;
    pw_cs_session *s=&r->slots[r->admitted++];s->root=r;s->role=PW_SS_CHILD;*out=s;
    int rc=pw_state_adopt_fixture_v1(r->transport,&s->transport);
    return rc?latch(s,PW_CS_TRANSPORT,rc,0):PW_CS_OK;
}
int pw_cs_resume_fixture_v1(pw_cs_session *s){return s&&owned(s->root)?pw_fixture_resume_reader(s->transport):PW_OWNER;}
static int observed(pw_cs_session *s) {
    int rc=pw_observe_direct_exit(s->transport);
    if(rc!=PW_OK&&rc!=PW_AGAIN)return latch(s,PW_CS_TRANSPORT,rc,0);
    pw_snapshot_v2 snapshot;
    if(pw_inspect_v2(s->root->transport,s->transport,PW_SNAPSHOT_ABI_V2,sizeof(snapshot),&snapshot))return latch(s,PW_CS_TRANSPORT,PW_SYSTEM,0);
    // Only CLOSING may drain a queued CLOSE_ACK after a real wait. Outside
    // closing, mirror state/JS directExit immediately, even with queued data.
    if(snapshot.direct_exit_observed){
        rc=pw_ss_direct_exit_v1(s->state);
        if(rc)return latch(s,PW_CS_PROTOCOL,0,rc);
    }
    return PW_CS_OK;
}
static int commit_event(pw_cs_session *s,pw_ss_event_v1 *e) {
    if(e->event==PW_SS_CLOSED_EVENT){s->closed=1;pw_cancel(s->transport);return PW_CS_OK;}
    if(e->event==PW_SS_REQUEST_EVENT)s->handling=1;
    return PW_CS_OK;
}
#endif
int pw_cs_pump_v1(pw_cs_session *s,pw_ss_event_v1 *out,size_t n) {
    if(!out||n!=sizeof(*out))return PW_CS_INPUT;memset(out,0,n);out->abi_version=1;out->struct_bytes=n;
    if(!s||!owned(s->root))return PW_CS_OWNER;if(s->error)return s->error;if(s->closed)return PW_CS_CLOSED;
#ifndef PW_ANONYMOUS_STATE_FIXTURE
    return PW_CS_REFUSED;
#else
    if(!s->bootstrap){
        int rc=s->role==PW_SS_PARENT?pw_state_bootstrap_step_fixture_v1(s->transport):pw_state_accept_step_fixture_v1(s->transport,s->root->state,&s->state);
        if(rc==PW_AGAIN)return PW_CS_AGAIN;if(rc)return latch(s,PW_CS_TRANSPORT,rc,0);s->bootstrap=1;
        return PW_CS_AGAIN; // bootstrap gets its own bounded scheduling turn
    }
    int rc=pw_ss_tick_v1(s->state);if(rc)return latch(s,PW_CS_PROTOCOL,0,rc);
    if(observed(s))return s->error;
    // A REQUEST view borrows the transport input. Keep it immutable until
    // respond has copied it; pumping while a handler is pending cannot reuse
    // the input buffer. Still tick/observe above so idle handlers can expire.
    if(s->handling)return PW_CS_BUSY;
    if(!s->writing){
        const unsigned char *p;size_t bytes;uint64_t token;
        rc=pw_ss_outbound_v1(s->state,&p,&bytes,&token);
        if(!rc){rc=pw_state_write_begin_fixture_v1(s->transport,p,bytes);if(rc)return latch(s,PW_CS_TRANSPORT,rc,0);s->writing=1;s->token=token;}
        else if(rc!=PW_SS_BUSY)return latch(s,PW_CS_PROTOCOL,0,rc);
    }
    if(s->writing){
        rc=pw_state_write_step_fixture_v1(s->transport);
        if(rc!=PW_AGAIN){if(rc)return latch(s,PW_CS_TRANSPORT,rc,0);s->writing=0;
            rc=pw_ss_write_done_v1(s->state,s->token,1,out,sizeof(*out));if(rc)return latch(s,PW_CS_PROTOCOL,0,rc);
            commit_event(s,out);if(out->event)return PW_CS_OK;}
    }
    const unsigned char *p;size_t bytes;
    rc=pw_state_read_fixture_v1(s->transport,&p,&bytes);
    if(rc==PW_AGAIN)return PW_CS_AGAIN;
    if(rc){int st=0;if(rc==PW_EOF||rc==PW_TRUNCATED)st=pw_ss_eof_v1(s->state);return latch(s,PW_CS_TRANSPORT,rc,st);}
    rc=pw_ss_receive_v1(s->state,p,bytes,out,sizeof(*out));if(rc)return latch(s,PW_CS_PROTOCOL,0,rc);
    commit_event(s,out);return out->event?PW_CS_OK:PW_CS_AGAIN;
#endif
}
static int available(pw_cs_session *s){if(!s||!owned(s->root))return PW_CS_OWNER;if(s->error)return s->error;if(s->closed)return PW_CS_CLOSED;return s->state?PW_CS_OK:PW_CS_BUSY;}
int pw_cs_request_v1(pw_cs_session *s,uint64_t op,const unsigned char *p,size_t n){int rc=available(s);if(rc)return rc;rc=pw_ss_request_v1(s->state,op,p,n);return !rc?0:rc==PW_SS_BUSY?PW_CS_BUSY:latch(s,PW_CS_PROTOCOL,0,rc);}
int pw_cs_respond_v1(pw_cs_session *s,const unsigned char *p,size_t n){int rc=available(s);if(rc)return rc;rc=pw_ss_respond_v1(s->state,p,n);if(!rc){s->handling=0;return 0;}return rc==PW_SS_BUSY?PW_CS_BUSY:latch(s,PW_CS_PROTOCOL,0,rc);}
int pw_cs_close_v1(pw_cs_session *s){int rc=available(s);if(rc)return rc;rc=pw_ss_close_v1(s->state);return !rc?0:rc==PW_SS_BUSY?PW_CS_BUSY:latch(s,PW_CS_PROTOCOL,0,rc);}
int pw_cs_abort_v1(pw_cs_session *s){if(!s||!owned(s->root))return PW_CS_OWNER;return latch(s,PW_CS_PROTOCOL,0,PW_SS_ABORTED);}
int pw_cs_observe_v1(pw_cs_session *s){if(!s||!owned(s->root))return PW_CS_OWNER;return pw_observe_direct_exit(s->transport);}
int pw_cs_terminate_v1(pw_cs_session *s){if(!s||!owned(s->root))return PW_CS_OWNER;return pw_terminate_direct_child(s->transport);}
int pw_cs_inspect_v1(pw_cs_session *s,pw_cs_snapshot_v1 *out,size_t n){
    if(!out||n!=sizeof(*out))return PW_CS_INPUT;if(!s||!owned(s->root))return PW_CS_OWNER;memset(out,0,n);
    if(s->transport)pw_inspect_v2(s->root->transport,s->transport,PW_SNAPSHOT_ABI_V2,sizeof(out->transport),&out->transport);
    pw_ss_inspect_v1(s->root->state,s->state,&out->state,sizeof(out->state));
    out->wrapper_reserved_bytes=sizeof(*s->root);out->error=s->error;out->transport_error=s->transport_error;out->state_error=s->state_error;out->protocol_closed=s->closed;out->state_available=s->state!=NULL;return 0;
}
int pw_cs_trace_v1(pw_cs_root *r,size_t i,pw_read_trace *out){return owned(r)?pw_trace_at(r->transport,i,out):PW_OWNER;}
int pw_cs_root_destroy_v1(pw_cs_root *r){
    if(!owned(r))return PW_CS_OWNER;
    int rc;if(r->transport){rc=pw_root_destroy(r->transport);if(rc)return PW_CS_TRANSPORT;r->transport=NULL;
        for(size_t i=0;i<r->admitted;i++)r->slots[i].transport=NULL;}
    if(r->state){rc=pw_ss_root_destroy_v1(r->state);if(rc)return PW_CS_PROTOCOL;r->state=NULL;}
    memset(r,0,sizeof(*r));free(r);return 0;
}
