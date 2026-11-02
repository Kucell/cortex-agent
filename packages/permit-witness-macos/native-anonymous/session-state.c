#include "session-state.h"
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef __APPLE__
#include <CommonCrypto/CommonDigest.h>
#endif
enum { HELLO=1, HELLO_ACK=2, REQUEST=3, RESPONSE=4, CLOSE=5, CLOSE_ACK=6 };
struct pw_ss_session {
    pw_ss_root *root;
    unsigned char key[32], session[16], challenge[32], hello_digest[32], binding[32];
    uint16_t operations[PW_SS_MAX_OPERATIONS], operation;
    size_t operation_count;
    unsigned max_frames, incoming, outgoing;
    uint32_t in_seq,out_seq,id;
    int role,phase,terminal,key_wiped,hello_written,hello_reply,pending,written,reply,busy;
    uint64_t deadline,token;
    pw_sw_budget *encoding;
    pw_sw_frame *frame;
    unsigned char *result;
    size_t result_size;
};
struct pw_ss_root {
    pthread_t owner;
    size_t sessions,capacity,sent,received;
    pw_ss_session *slots[PW_SS_MAX_SESSIONS];
};
static void wipe(void *p,size_t n){volatile unsigned char *v=p;while(n--)*v++=0;}
static int owned(pw_ss_root *r){return r && pthread_equal(r->owner,pthread_self());}
static int equal(const unsigned char *a,const unsigned char *b,size_t n){volatile unsigned d=0;for(size_t i=0;i<n;i++)d|=a[i]^b[i];return !d;}
static const unsigned char zero[32];
uint64_t pw_ss_now_ns_v1(void){struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t))return 0;return (uint64_t)t.tv_sec*1000000000ULL+(uint64_t)t.tv_nsec;}
static int charge(pw_ss_root *r,size_t n){if(n>PW_SS_CAPACITY_LIMIT-r->capacity)return PW_SS_BUDGET;r->capacity+=n;return PW_SS_OK;}
static void drop_writer(pw_ss_session *s){if(s->encoding)pw_sw_budget_destroy_v1(s->encoding);s->encoding=NULL;s->frame=NULL;}
static void clear_key(pw_ss_session *s){wipe(s->key,32);wipe(s->session,16);wipe(s->challenge,32);wipe(s->hello_digest,32);wipe(s->binding,32);s->key_wiped=1;}
static int terminal(pw_ss_session *s,int code){
    if(s->phase==PW_SS_FINISHED)return PW_SS_CLOSED;
    if(s->phase==PW_SS_FAILED)return s->terminal;
    s->phase=PW_SS_FAILED;s->terminal=code;drop_writer(s);clear_key(s);
    if(s->result){wipe(s->result,s->result_size);free(s->result);s->result=NULL;s->result_size=0;}
    return code;
}
static void finish(pw_ss_session *s){s->phase=PW_SS_FINISHED;drop_writer(s);clear_key(s);}
static int check(pw_ss_session *s){
    if(!s || !owned(s->root))return PW_SS_OWNER;
    if(s->phase==PW_SS_FAILED)return s->terminal;
    if(s->phase==PW_SS_FINISHED)return PW_SS_CLOSED;
    uint64_t now=pw_ss_now_ns_v1();if(!now)return terminal(s,PW_SS_SYSTEM);
    return now>=s->deadline?terminal(s,PW_SS_DEADLINE):PW_SS_OK;
}
static int output(pw_ss_event_v1 *out,size_t n){if(!out||n!=sizeof(*out))return PW_SS_INPUT;memset(out,0,sizeof(*out));out->abi_version=1;out->struct_bytes=sizeof(*out);return 0;}
static void event(pw_ss_session *s,pw_ss_event_v1 *out,int kind,const unsigned char *p,size_t n){out->event=kind;out->request_id=s->id;out->operation=s->operation;out->payload=p;out->payload_bytes=n;}
static int allowed(pw_ss_session *s,uint64_t op){for(size_t i=0;i<s->operation_count;i++)if(op==s->operations[i])return 1;return 0;}
static int send_frame(pw_ss_session *s,unsigned type,uint32_t id,uint16_t op,const unsigned char *binding,const unsigned char *payload,size_t n){
    int rc=check(s);if(rc)return rc;
    if(s->encoding)return terminal(s,PW_SS_WRITE);
    if(n>PW_SW_MAX_PAYLOAD || (n&&!payload))return terminal(s,PW_SS_SIZE);
    if(s->outgoing>=s->max_frames || s->out_seq==UINT32_MAX || s->token==UINT64_MAX)return terminal(s,PW_SS_FRAME_LIMIT);
    size_t length=PW_SW_OVERHEAD+n;
    if(length>PW_SS_BYTE_LIMIT-s->root->sent)return terminal(s,PW_SS_BUDGET);
    s->root->sent+=length;s->outgoing++;s->out_seq++;s->token++;
    // Reserve before creating even wire's metadata/budget allocation. The
    // underlying budget is single-frame here; its 16-encoding lifetime cap
    // cannot silently reduce this state machine's 64-frame capability.
    if((rc=charge(s->root,length+PW_SS_WIRE_METADATA_ALLOWANCE)))return terminal(s,rc);
    s->encoding=pw_sw_budget_create_v1();if(!s->encoding)return terminal(s,PW_SS_SYSTEM);
    pw_sw_fields_v1 f={0};f.direction=s->role==PW_SS_PARENT?1:2;f.type=type;f.seq=s->out_seq;f.request_id=id;f.operation=op;
    memcpy(f.session,s->session,16);memcpy(f.binding,binding,32);
    rc=pw_sw_encode_v1(s->encoding,s->key,32,&f,sizeof(f),payload,n,&s->frame);
    return rc==PW_SW_OK?check(s):terminal(s,PW_SS_SYSTEM);
}
pw_ss_root *pw_ss_root_create_v1(void){
    if(!pw_sw_platform_supported_v1())return NULL;
    pw_ss_root *r=calloc(1,sizeof(*r));if(r){r->owner=pthread_self();r->capacity=sizeof(*r);}return r;
}
int pw_ss_create_v1(pw_ss_root *r,int role,const unsigned char *key,size_t key_n,const unsigned char *session,size_t session_n,uint64_t deadline,
    const uint16_t *ops,size_t count,unsigned max_frames,pw_ss_session **out){
    if(!out)return PW_SS_INPUT;*out=NULL;
    if(!owned(r))return PW_SS_OWNER;
    if(!pw_sw_platform_supported_v1())return PW_SS_UNSUPPORTED;
    if((role!=PW_SS_PARENT&&role!=PW_SS_CHILD)||!key||key_n!=32||!session||session_n!=16||!ops||!count||count>64||!max_frames||max_frames>64)return PW_SS_INPUT;
    for(size_t i=0;i<count;i++)if(!ops[i])return PW_SS_INPUT;
    uint64_t now=pw_ss_now_ns_v1();if(!now||deadline<=now||deadline-now>60000000000ULL)return PW_SS_DEADLINE;
    if(r->sessions==PW_SS_MAX_SESSIONS)return PW_SS_ADMISSION;
    r->sessions++;int rc=charge(r,sizeof(pw_ss_session));if(rc)return rc;
    pw_ss_session *s=calloc(1,sizeof(*s));if(!s)return PW_SS_SYSTEM;
    r->slots[r->sessions-1]=s;s->root=r;s->role=role;s->phase=role==PW_SS_PARENT?PW_SS_HELLO:PW_SS_AWAIT_HELLO;
    s->deadline=deadline;s->max_frames=max_frames;s->operation_count=count;memcpy(s->operations,ops,count*sizeof(*ops));
    memcpy(s->key,key,32);memcpy(s->session,session,16);*out=s;
    if(role==PW_SS_PARENT){
        arc4random_buf(s->challenge,32);
        rc=send_frame(s,HELLO,0,0,zero,s->challenge,32);
        if(!rc){size_t n;const unsigned char *p=pw_sw_frame_view_v1(s->frame,&n);
#ifdef __APPLE__
            if(!CC_SHA256(p,(CC_LONG)n,s->hello_digest))return terminal(s,PW_SS_SYSTEM);
#endif
        }
    }
    return rc;
}
int pw_ss_outbound_v1(pw_ss_session *s,const unsigned char **p,size_t *n,uint64_t *token){
    if(p)*p=NULL;if(n)*n=0;if(token)*token=0;
    if(!p||!n||!token)return PW_SS_INPUT;int rc=check(s);if(rc)return rc;
    if(!s->frame)return PW_SS_BUSY;*p=pw_sw_frame_view_v1(s->frame,n);*token=s->token;return *p?0:terminal(s,PW_SS_SYSTEM);
}
static void settle(pw_ss_session *s,pw_ss_event_v1 *out){
    if(!s->pending||!s->written||!s->reply)return;
    s->pending=0;
    if(s->phase==PW_SS_CLOSING){finish(s);event(s,out,PW_SS_CLOSED_EVENT,NULL,0);}
    else event(s,out,PW_SS_RESPONSE_EVENT,s->result,s->result_size);
}
int pw_ss_write_done_v1(pw_ss_session *s,uint64_t token,int success,pw_ss_event_v1 *out,size_t n){
    int rc=output(out,n);if(rc)return rc;rc=check(s);if(rc)return rc;
    if(!s->frame||token!=s->token)return terminal(s,PW_SS_TOKEN);
    if(success!=1)return terminal(s,PW_SS_WRITE);
    drop_writer(s);
    if(s->role==PW_SS_PARENT){
        if(s->phase==PW_SS_HELLO){s->hello_written=1;if(s->hello_reply){s->phase=PW_SS_READY;event(s,out,PW_SS_READY_EVENT,NULL,0);}}
        else if(s->pending){s->written=1;settle(s,out);}
    }else{
        if(s->phase==PW_SS_HELLO_ACK){s->phase=PW_SS_READY;event(s,out,PW_SS_READY_EVENT,NULL,0);}
        else if(s->phase==PW_SS_CLOSING){finish(s);event(s,out,PW_SS_CLOSED_EVENT,NULL,0);}
        else s->busy=0;
    }
    return PW_SS_OK;
}
static uint32_t u32(const unsigned char *p){return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3];}
int pw_ss_receive_v1(pw_ss_session *s,const unsigned char *p,size_t n,pw_ss_event_v1 *out,size_t out_n){
    int rc=output(out,out_n);if(rc)return rc;rc=check(s);if(rc)return rc;
    if(!p||n<PW_SW_OVERHEAD||n>PW_SW_MAX_FRAME)return terminal(s,PW_SS_SIZE);
    if(s->incoming>=s->max_frames||s->in_seq==UINT32_MAX)return terminal(s,PW_SS_FRAME_LIMIT);
    if(n>PW_SS_BYTE_LIMIT-s->root->received)return terminal(s,PW_SS_BUDGET);
    s->root->received+=n;s->incoming++;s->in_seq++;
    // Existing wire requires ALL expected fields. Copy raw type/id/op/binding
    // only after size validation so the MAC can be verified once; these are
    // untrusted until below state-specific checks. Domain/session/seq always
    // come exclusively from private state, never from the untrusted frame.
    pw_sw_fields_v1 expected={0};expected.direction=s->role==PW_SS_PARENT?2:1;expected.type=p[6];expected.seq=s->in_seq;
    expected.request_id=u32(p+12);expected.operation=((uint16_t)p[16]<<8)|p[17];memcpy(expected.binding,p+34,32);memcpy(expected.session,s->session,16);
    pw_sw_decoded_v1 m;rc=pw_sw_verify_v1(s->key,32,&expected,sizeof(expected),p,n,&m,sizeof(m));
    if(rc)return terminal(s,rc==PW_SW_MAC?PW_SS_MAC:rc==PW_SW_DOMAIN?PW_SS_DOMAIN:rc==PW_SW_SEQUENCE?PW_SS_SEQUENCE:PW_SS_SIZE);
    rc=check(s);if(rc)return rc;
    if(s->role==PW_SS_CHILD&&s->phase==PW_SS_AWAIT_HELLO){
        if(m.fields.type!=HELLO||m.fields.request_id||m.fields.operation||!equal(m.fields.binding,zero,32)||m.payload_bytes!=32)return terminal(s,PW_SS_HANDSHAKE);
        s->phase=PW_SS_HELLO_ACK;return send_frame(s,HELLO_ACK,0,0,m.digest,m.payload,32);
    }
    if(s->role==PW_SS_PARENT&&s->phase==PW_SS_HELLO){
        if(m.fields.type!=HELLO_ACK||m.fields.request_id||m.fields.operation||!equal(m.fields.binding,s->hello_digest,32)||m.payload_bytes!=32||!equal(m.payload,s->challenge,32)||s->hello_reply)return terminal(s,PW_SS_HANDSHAKE);
        s->hello_reply=1;if(s->hello_written){s->phase=PW_SS_READY;event(s,out,PW_SS_READY_EVENT,NULL,0);}return 0;
    }
    if(s->role==PW_SS_PARENT){
        int closing=s->phase==PW_SS_CLOSING;
        if(!((s->phase==PW_SS_READY&&m.fields.type==RESPONSE)||(closing&&m.fields.type==CLOSE_ACK&&!m.payload_bytes)))return terminal(s,PW_SS_UNEXPECTED_MESSAGE);
        if(!s->pending||s->reply||m.fields.request_id!=s->id||m.fields.operation!=s->operation||!equal(m.fields.binding,s->binding,32))return terminal(s,PW_SS_CORRELATION);
        unsigned char *next_result=NULL;
        if(m.payload_bytes){
            if((rc=charge(s->root,m.payload_bytes)))return terminal(s,rc);
            next_result=malloc(m.payload_bytes);if(!next_result)return terminal(s,PW_SS_SYSTEM);
            // Incoming bytes may alias the previous result borrowed by caller.
            // Preserve old storage until verification AND this copy finish.
            memcpy(next_result,m.payload,m.payload_bytes);
        }
        if(s->result){wipe(s->result,s->result_size);free(s->result);}
        s->result=next_result;s->result_size=m.payload_bytes;
        rc=check(s);if(rc)return rc;s->reply=1;settle(s,out);return 0;
    }
    if(s->phase!=PW_SS_READY||s->busy)return terminal(s,PW_SS_UNEXPECTED_MESSAGE);
    if(s->id==UINT32_MAX||m.fields.request_id!=s->id+1||!equal(m.fields.binding,zero,32))return terminal(s,PW_SS_CORRELATION);
    s->id=(uint32_t)m.fields.request_id;s->operation=(uint16_t)m.fields.operation;memcpy(s->binding,m.digest,32);
    if(m.fields.type==CLOSE&&!s->operation&&!m.payload_bytes){s->phase=PW_SS_CLOSING;return send_frame(s,CLOSE_ACK,s->id,0,m.digest,NULL,0);}
    if(m.fields.type!=REQUEST||!allowed(s,s->operation))return terminal(s,PW_SS_OPERATION);
    s->busy=1;event(s,out,PW_SS_REQUEST_EVENT,m.payload,m.payload_bytes);return 0;
}
static int exchange(pw_ss_session *s,unsigned type,uint64_t op,const unsigned char *payload,size_t n){
    int rc=check(s);if(rc)return rc;
    if(s->role!=PW_SS_PARENT||s->phase!=PW_SS_READY||s->pending)return PW_SS_BUSY;
    if(n>PW_SW_MAX_PAYLOAD||(n&&!payload))return PW_SS_SIZE;
    if(op>UINT16_MAX||(type==REQUEST&&!allowed(s,op)))return PW_SS_OPERATION;
    if(s->id==UINT32_MAX)return terminal(s,PW_SS_FRAME_LIMIT);
    s->pending=1;s->written=s->reply=0;s->id++;s->operation=(uint16_t)op;
    if(type==CLOSE)s->phase=PW_SS_CLOSING;
    rc=send_frame(s,type,s->id,(uint16_t)op,zero,payload,n);
    if(!rc){size_t bytes;const unsigned char *p=pw_sw_frame_view_v1(s->frame,&bytes);
#ifdef __APPLE__
        if(!CC_SHA256(p,(CC_LONG)bytes,s->binding))return terminal(s,PW_SS_SYSTEM);
#endif
    }
    return rc;
}
int pw_ss_request_v1(pw_ss_session *s,uint64_t op,const unsigned char *p,size_t n){return exchange(s,REQUEST,op,p,n);}
int pw_ss_close_v1(pw_ss_session *s){return exchange(s,CLOSE,0,NULL,0);}
int pw_ss_respond_v1(pw_ss_session *s,const unsigned char *p,size_t n){
    int rc=check(s);if(rc)return rc;
    if(s->role!=PW_SS_CHILD||s->phase!=PW_SS_READY||!s->busy||s->encoding)return PW_SS_BUSY;
    return send_frame(s,RESPONSE,s->id,s->operation,s->binding,p,n);
}
int pw_ss_tick_v1(pw_ss_session *s){return check(s);}
int pw_ss_abort_v1(pw_ss_session *s){if(!s||!owned(s->root))return PW_SS_OWNER;return terminal(s,PW_SS_ABORTED);}
int pw_ss_eof_v1(pw_ss_session *s){if(!s||!owned(s->root))return PW_SS_OWNER;return terminal(s,PW_SS_DISCONNECTED);}
int pw_ss_direct_exit_v1(pw_ss_session *s){int rc=check(s);if(rc)return rc;return s->phase==PW_SS_CLOSING?0:terminal(s,PW_SS_DIRECT_EXIT);}
int pw_ss_inspect_v1(pw_ss_root *r,pw_ss_session *s,pw_ss_snapshot_v1 *out,size_t n){
    if(!out||n!=sizeof(*out))return PW_SS_INPUT;if(!owned(r)||(s&&s->root!=r))return PW_SS_OWNER;
    memset(out,0,sizeof(*out));out->sessions_retained=r->sessions;out->capacity_reserved=r->capacity;out->sent_reserved=r->sent;out->received_charged=r->received;
    out->capacity_limit=PW_SS_CAPACITY_LIMIT;out->byte_limit=PW_SS_BYTE_LIMIT;
    if(s){out->in_sequence=s->in_seq;out->out_sequence=s->out_seq;out->request_id=s->id;out->incoming_frames=s->incoming;out->outgoing_frames=s->outgoing;
        out->phase=s->phase;out->terminal_code=s->terminal;out->key_wiped=s->key_wiped&&equal(s->key,zero,32)&&equal(s->session,zero,16)&&equal(s->challenge,zero,32);
        out->session_key_holder=s->phase==PW_SS_READY||s->phase==PW_SS_CLOSING||s->phase==PW_SS_FINISHED;}
    return 0;
}
int pw_ss_root_destroy_v1(pw_ss_root *r){
    if(!owned(r))return PW_SS_OWNER;
    for(size_t i=0;i<r->sessions;i++){pw_ss_session *s=r->slots[i];if(!s)continue;drop_writer(s);clear_key(s);if(s->result){wipe(s->result,s->result_size);free(s->result);}wipe(s,sizeof(*s));free(s);}
    wipe(r,sizeof(*r));free(r);return 0;
}
const char *pw_ss_code_name_v1(int code){static const char *const names[]={"OK","BUSY","INPUT","UNSUPPORTED","OWNER","ADMISSION","BUDGET","SYSTEM","SIZE","MAC","DOMAIN","SEQUENCE","HANDSHAKE","CORRELATION","UNEXPECTED_MESSAGE","OPERATION","FRAME_LIMIT","DEADLINE","WRITE","ABORTED","DISCONNECTED","DIRECT_EXIT","CLOSED","TOKEN"};return code>=0&&(size_t)code<sizeof(names)/sizeof(names[0])?names[code]:"UNKNOWN";}
