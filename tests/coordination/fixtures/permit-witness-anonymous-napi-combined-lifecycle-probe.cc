#define NAPI_VERSION 8
#include <node_api.h>
#include <uv.h>
extern "C" {
#include "combined-session.h"
}
#include <array>
#include <cassert>
#include <mutex>
#include <condition_variable>
#include <string>
#include <chrono>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <sys/types.h>
extern "C" ssize_t pw_napi_test_write(int,const void *,size_t);
namespace {
struct Record {
    const void *bridge=nullptr;napi_env env=nullptr;uv_async_t *handle=nullptr;
    unsigned token=0,seq=0,before=0,published=0,sent=0,released_owner=0,close_started=0,closed=0,deleted=0,finalized=0,cleanup=0,entered=0,destroy_failed=0,destroyed=0,finalizer_entered=0;
    bool reached=false,released=false;std::string mode;pw_cs_root *root=nullptr;
    std::array<pw_cs_session *,PW_SESSION_MAX> sessions{};size_t count=0,capacity=0,state_capacity=0;bool wait_proven=false;
    pw_cs_root *native_root=nullptr;int first_error=0;pw_cs_snapshot_v1 first_snapshot{};
    std::array<pw_read_trace,8> first_trace{};size_t first_trace_count=0;
    napi_finalize original_finalizer=nullptr;void *finalizer_data=nullptr;
    size_t blocked_writes=0,blocked_sent=0,blocked_reserved=0,blocked_alive=0,cancel_alive=0,terminate_calls=0;
    bool abort_seen=false;
};
std::array<Record,64> records;unsigned count=0;std::mutex mutex;std::condition_variable changed;std::string next_mode;
thread_local Record *owner=nullptr;
Record &find(const void *p){for(unsigned i=count;i;i--)if(records[i-1].bridge==p)return records[i-1];assert(false);return records[0];}
Record &select(napi_env env,napi_callback_info info){napi_value arg;size_t argc=1;void *data;
    assert(napi_get_cb_info(env,info,&argc,&arg,nullptr,&data)==napi_ok);
    if(!argc)return *static_cast<Record *>(data);unsigned token;assert(napi_get_value_uint32(env,arg,&token)==napi_ok&&token&&token<=count);return records[token-1];}
napi_value status(napi_env env,napi_callback_info info){auto &r=select(env,info);std::lock_guard<std::mutex> g(mutex);napi_value obj,v;napi_create_object(env,&obj);
    for(auto pair:{std::pair<const char *,unsigned>{"token",r.token},{"before",r.before},{"published",r.published},{"sent",r.sent},{"ownerRelease",r.released_owner},
        {"closeStarted",r.close_started},{"closed",r.closed},{"deleted",r.deleted},{"finalized",r.finalized},{"cleanup",r.cleanup},{"entered",r.entered},{"destroyFailed",r.destroy_failed},{"destroyed",r.destroyed},{"finalizerEntered",r.finalizer_entered}}){
        napi_create_uint32(env,pair.second,&v);napi_set_named_property(env,obj,pair.first,v);}
    napi_get_boolean(env,r.reached,&v);napi_set_named_property(env,obj,"reached",v);
    napi_get_boolean(env,r.wait_proven,&v);napi_set_named_property(env,obj,"waitProven",v);
    napi_create_double(env,static_cast<double>(r.capacity),&v);napi_set_named_property(env,obj,"capacityRetained",v);
    napi_create_double(env,static_cast<double>(r.state_capacity),&v);napi_set_named_property(env,obj,"stateCapacityRetained",v);
    for(auto pair:{std::pair<const char *,size_t>{"blockedWrites",r.blocked_writes},{"blockedSent",r.blocked_sent},{"blockedReserved",r.blocked_reserved},
        {"blockedAlive",r.blocked_alive},{"cancelAlive",r.cancel_alive},{"terminateCalls",r.terminate_calls}}){
        napi_create_double(env,static_cast<double>(pair.second),&v);napi_set_named_property(env,obj,pair.first,v);}
    napi_value failure,trace,row; napi_create_object(env,&failure);
    for(auto pair:{std::pair<const char *,size_t>{"code",static_cast<size_t>(r.first_error)},
      {"transportError",static_cast<size_t>(r.first_snapshot.transport_error)},{"stateError",static_cast<size_t>(r.first_snapshot.state_error)},
      {"receivedBytes",r.first_snapshot.transport.received_bytes},{"sentBytes",r.first_snapshot.transport.sent_bytes},{"traceCount",r.first_snapshot.transport.trace_count},
      {"directExitObserved",static_cast<size_t>(r.first_snapshot.transport.direct_exit_observed)}}){napi_create_double(env,static_cast<double>(pair.second),&v);napi_set_named_property(env,failure,pair.first,v);}
    napi_create_array_with_length(env,r.first_trace_count,&trace);
    for(size_t i=0;i<r.first_trace_count;i++){auto &t=r.first_trace[i];napi_create_array_with_length(env,5,&row);unsigned j=0;
      for(double x:{static_cast<double>(t.credit),static_cast<double>(t.phase_remaining),static_cast<double>(t.total_remaining),static_cast<double>(t.reserved_before_read),static_cast<double>(t.result)}){
        napi_create_double(env,x,&v);napi_set_element(env,row,j++ ,v);}napi_set_element(env,trace,static_cast<uint32_t>(i),row);}
    napi_set_named_property(env,failure,"lastReadCredits",trace);napi_set_named_property(env,obj,"firstNativeFailure",failure);return obj;}
napi_value arm(napi_env env,napi_callback_info info){napi_value arg;size_t argc=1;char text[64];size_t size;
    assert(napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr)==napi_ok&&argc==1);
    assert(napi_get_value_string_utf8(env,arg,text,sizeof(text),&size)==napi_ok);
    {std::lock_guard<std::mutex> g(mutex);next_mode=text;}napi_value v;napi_get_undefined(env,&v);return v;}
napi_value release(napi_env env,napi_callback_info info){auto &r=select(env,info);{std::lock_guard<std::mutex> g(mutex);r.released=true;changed.notify_all();}napi_value v;napi_get_undefined(env,&v);return v;}
napi_value pulse(napi_env env,napi_callback_info info){auto &r=select(env,info);{std::lock_guard<std::mutex> g(mutex);assert(!r.close_started&&!r.closed&&!r.deleted);assert(!uv_async_send(r.handle));}napi_value v;napi_get_undefined(env,&v);return v;}
}
extern "C" void pw_cs_test_register(napi_env env,const void *b,uv_async_t *h){std::lock_guard<std::mutex> g(mutex);assert(count<records.size());auto &r=records[count++];r.bridge=b;r.env=env;r.handle=h;r.token=count;r.mode=next_mode;}
extern "C" bool pw_cs_test_fail(const void *b,const char *point){std::lock_guard<std::mutex> g(mutex);return find(b).mode==point;}
extern "C" void pw_cs_test_point(const void *b,const char *point){std::unique_lock<std::mutex> g(mutex);auto &r=find(b);
    if(!strcmp(point,"owner-enter")){owner=&r;return;}
    if(!strcmp(point,"completion-enter")){r.entered++;changed.notify_all();return;}
    if(!strcmp(point,"owner-before-done")){assert(!r.before);r.before=++r.seq;}
    if(!strcmp(point,"owner-published")){assert(!r.published);r.published=++r.seq;}
    if(!strcmp(point,"owner-sending")&&r.close_started){
        std::fputs("PW_CS_PROBE_SEND_AFTER_UV_CLOSE_CALL\n",stderr);std::fflush(stderr);std::abort();
    }
    if(!strcmp(point,"owner-sent")){assert(!r.sent&&!r.close_started&&!r.closed);r.sent=++r.seq;changed.notify_all();}
    if(!strcmp(point,"owner-release")){assert(!r.released_owner);r.released_owner=++r.seq;}
    if(!strcmp(point,"tsfn-finalized")){assert(!r.finalized);r.finalized=++r.seq;}
    if(!strcmp(point,"cleanup-start")){assert(!r.cleanup);r.cleanup=++r.seq;}
    if(!strcmp(point,"root-destroyed")){assert(!r.destroyed);r.destroyed=++r.seq;}
    if(!strcmp(point,"completion-closed")){assert(r.close_started&&!r.closed);r.closed=++r.seq;}
    if(!strcmp(point,"bridge-delete")){assert(!r.deleted);r.deleted=++r.seq;}
    // All JS-controlled waits are outside Bridge mutex/wake_mutex: before-done
    // is outside its publication lock. Unsafe mutation removes that lock too.
    bool barrier=r.mode=="owner-before-done"&&!strcmp(point,"owner-before-done");
    // Both armed mode names must arm this barrier: `owner-published` is the
    // positive run and `unsafe-owner-published` is the negative run that
    // removes the publication lock. Matching only one of them left the
    // barrier unarmed and the client waited until its timeout.
    barrier|=(!strcmp(r.mode.c_str(),"owner-published")||!strcmp(r.mode.c_str(),"unsafe-owner-published"))&&!strcmp(point,"owner-published");
    if(barrier&&!r.reached){r.reached=true;changed.notify_all();assert(changed.wait_for(g,std::chrono::seconds(5),[&r]{return r.released;}));}
}
extern "C" void pw_cs_test_uv_close(uv_handle_t *handle,uv_close_cb cb){
    {std::lock_guard<std::mutex> g(mutex);
     Record *selected=nullptr;for(unsigned i=count;i;i--)if(reinterpret_cast<uv_handle_t *>(records[i-1].handle)==handle){selected=&records[i-1];break;}
     assert(selected);auto &r=*selected;assert(!r.close_started&&!r.closed&&!r.deleted);r.close_started=++r.seq;
     // Record invocation, not a later callback; uv_close is called immediately.
     uv_close(handle,cb);changed.notify_all();}
}
static void test_finalizer(napi_env env,void *data,void *hint){
    auto &r=*static_cast<Record *>(data);napi_finalize fn;void *original;
    {std::unique_lock<std::mutex> g(mutex);r.finalizer_entered=++r.seq;changed.notify_all();
     // JS has entered the actual TSFN finalizer. Wait only for native owner
     // completion: no Bridge lock is held and the owner never needs JS here.
     if(r.mode=="owner-first")assert(changed.wait_for(g,std::chrono::seconds(5),[&r]{return r.sent!=0;}));
     fn=r.original_finalizer;original=r.finalizer_data;}
    fn(env,original,hint);
}
extern "C" napi_status pw_cs_test_create_tsfn(napi_env env,napi_value func,napi_value resource,napi_value name,size_t queue,size_t threads,
    void *data,napi_finalize finalizer,void *context,napi_threadsafe_function_call_js call,napi_threadsafe_function *result){
    Record *r=nullptr;{std::lock_guard<std::mutex> g(mutex);for(unsigned i=count;i;i--)if(records[i-1].env==env){r=&records[i-1];break;}
      assert(r);r->original_finalizer=finalizer;r->finalizer_data=data;}
    return napi_create_threadsafe_function(env,func,resource,name,queue,threads,r,test_finalizer,context,call,result);
}
extern "C" int pw_cs_test_start(pw_cs_root *root,uint64_t deadline,pw_cs_session **out){
    assert(owner);owner->native_root=root;int rc=pw_cs_start_v1(root,deadline,out);
    if(*out){assert(owner->count<owner->sessions.size());owner->sessions[owner->count++]=*out;}return rc;
}
static void capture_failure(pw_cs_session *s,int rc){
    if(rc==PW_CS_OK||rc==PW_CS_AGAIN||rc==PW_CS_BUSY||rc==PW_CS_CLOSED)return;
    pw_cs_snapshot_v1 v{};assert(!pw_cs_inspect_v1(s,&v,sizeof(v)));std::lock_guard<std::mutex> g(mutex);
    if(owner->first_error)return;owner->first_error=rc;owner->first_snapshot=v;
    size_t begin=v.transport.trace_count>8?v.transport.trace_count-8:0;
    for(size_t i=begin;i<v.transport.trace_count;i++)assert(pw_cs_trace_v1(owner->native_root,i,&owner->first_trace[owner->first_trace_count++])==PW_OK);
}
extern "C" int pw_cs_test_pump(pw_cs_session *s,pw_ss_event_v1 *event,size_t n){
    int rc=pw_cs_pump_v1(s,event,n);capture_failure(s,rc);
    if(owner->blocked_writes){pw_cs_snapshot_v1 v{};assert(!pw_cs_inspect_v1(s,&v,sizeof(v)));int wait=pw_cs_observe_v1(s);
      std::lock_guard<std::mutex> g(mutex);owner->blocked_sent=v.transport.sent_bytes;owner->blocked_reserved=v.transport.reserved_send_bytes;
      if(wait==PW_AGAIN&&v.transport.sent_bytes<v.transport.reserved_send_bytes)owner->blocked_alive++;}
    return rc;
}
extern "C" int pw_cs_test_abort(pw_cs_session *s){int rc=pw_cs_abort_v1(s);{std::lock_guard<std::mutex> g(mutex);owner->abort_seen=true;}return rc;}
extern "C" int pw_cs_test_observe(pw_cs_session *s){int rc=pw_cs_observe_v1(s);
    {std::lock_guard<std::mutex> g(mutex);if(owner->abort_seen&&rc==PW_AGAIN)owner->cancel_alive++;}return rc;}
extern "C" int pw_cs_test_terminate(pw_cs_session *s){
    {std::lock_guard<std::mutex> g(mutex);owner->terminate_calls++;}return pw_cs_terminate_v1(s);}
extern "C" ssize_t pw_cs_test_write(int fd,const void *bytes,size_t n){
    ssize_t rc=pw_napi_test_write(fd,bytes,n);int saved=errno;
    if(rc<0&&(saved==EAGAIN||saved==EWOULDBLOCK)){std::lock_guard<std::mutex> g(mutex);assert(owner);owner->blocked_writes++;}
    errno=saved;return rc;
}
extern "C" int pw_cs_test_request(pw_cs_session *s,uint64_t op,const unsigned char *p,size_t n){int rc=pw_cs_request_v1(s,op,p,n);capture_failure(s,rc);return rc;}
extern "C" int pw_cs_test_destroy(pw_cs_root *root){assert(owner);
    pw_cs_snapshot_v1 snapshot{};
    for(size_t i=0;i<owner->count;i++){
        assert(!pw_cs_inspect_v1(owner->sessions[i],&snapshot,sizeof(snapshot)));
        assert(!snapshot.transport.launch_started||snapshot.transport.direct_exit_observed);
        assert(!snapshot.transport.open_fds);
    }
    {std::lock_guard<std::mutex> g(mutex);
    owner->wait_proven=owner->count>0;
    if(owner->capacity){assert(snapshot.transport.capacity_bytes==owner->capacity);assert(snapshot.state.capacity_reserved==owner->state_capacity);}
    owner->capacity=snapshot.transport.capacity_bytes;owner->state_capacity=snapshot.state.capacity_reserved;
    if(owner->mode=="destroy-failure"&&!owner->released){if(!owner->root)owner->root=root;assert(owner->root==root);owner->destroy_failed++;return PW_CS_TRANSPORT;}}
    return pw_cs_root_destroy_v1(root);
}
extern "C" void pw_cs_test_exports(napi_env env,napi_value exports,const void *b){Record *r;{std::lock_guard<std::mutex> g(mutex);r=&find(b);}
    for(auto item:{std::pair<const char *,napi_callback>{"testStatus",status},{"testArm",arm},{"testRelease",release},{"testPulse",pulse}}){napi_value fn;
        napi_create_function(env,item.first,NAPI_AUTO_LENGTH,item.second,r,&fn);napi_set_named_property(env,exports,item.first,fn);}
}
