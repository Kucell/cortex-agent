/* Link-time observation around the UNMODIFIED legacy harness and peer.
 * Only return-code observations; no injected delay, changed limit or retry. */
#include "anonymous.h"
#include <assert.h>
#include <stdio.h>
static pw_root *root;
static uint64_t start,deadline;
pw_root *pw_cs_diag_root_impl(void);
int pw_cs_diag_start_impl(pw_root *,uint64_t,pw_session **);
int pw_cs_diag_read_impl(pw_session *,const unsigned char **,size_t *);
int pw_cs_diag_handshake_impl(pw_session *);
pw_root *pw_root_create(void){start=pw_now_ns();root=pw_cs_diag_root_impl();return root;}
static void point(const char *stage,pw_session *s,int rc){
    pw_snapshot_v2 v;assert(!pw_inspect_v2(root,s,2,sizeof(v),&v));
    uint64_t now=pw_now_ns();
    fprintf(stderr,"{\"stage\":\"%s\",\"rc\":\"%s\",\"elapsedNs\":%llu,\"remainingNs\":%llu,\"sessions\":%zu,\"traceCount\":%zu,\"traceLimit\":%zu,\"received\":%zu,\"terminal\":\"%s\",\"readCallsThisSession\":%u}\n",stage,pw_result_name(rc),(unsigned long long)(now-start),(unsigned long long)(now<deadline?deadline-now:0),v.sessions,v.trace_count,v.trace_limit,v.received_bytes,pw_result_name(v.terminal),v.read_calls);
}
int pw_start(pw_root *r,uint64_t end,pw_session **out){deadline=end;int rc=pw_cs_diag_start_impl(r,end,out);if(*out)point("start",*out,rc);return rc;}
int pw_handshake_step(pw_session *s){int rc=pw_cs_diag_handshake_impl(s);if(rc!=PW_AGAIN)point("handshake",s,rc);return rc;}
int pw_read_frame_step(pw_session *s,const unsigned char **p,size_t *n){int rc=pw_cs_diag_read_impl(s,p,n);if(rc!=PW_AGAIN)point("receive",s,rc);return rc;}
