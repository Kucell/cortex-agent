#define NAPI_VERSION 8
#include <node_api.h>
extern "C" {
#include "anonymous.h"
#include "fixture-only.h"
}
#include <array>
#include <cassert>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <string>
#include <chrono>

// All controls and observations are bound to a specific Bridge. Tokens are
// monotonically assigned test identities, never pointer/PID/fd capabilities.
namespace {
enum Fault { NONE, POST_START, PRE_START, UNKNOWN_START, UNKNOWN_WAIT, DESTROY_FAILURE, CLOSING, BUFFER_COPY, BUFFER_EXCEPTION, BUFFER_LIVE, BUFFER_LIVE_EXCEPTION };
struct Record {
    const void *bridge = nullptr;
    unsigned token = 0, sequence = 0;
    unsigned cleanup = 0, finalized = 0, owner_done = 0, deleted = 0, completion_closed = 0, closing = 0;
    bool reached = false, released = false, destroy_failed = false, destroy_recovered = false;
    std::string armed;
    Fault fault = NONE;
    pw_root *failed_root = nullptr;
    pw_snapshot_v2 retained{};
    unsigned tsfn_calls_after_closing = 0;
    napi_env env = nullptr;
    bool read_completed = false, exit_observed = false, exit_published = false;
    unsigned buffer_failures = 0, resolved = 0, rejected = 0;
    pw_session *failed_session = nullptr, *other_session = nullptr;
    bool batch_ready = false, target_live = false, other_live = false, wait_released = false;
    bool target_cancelled = false, injected_alive = false;
    unsigned batch_reads = 0, release_calls = 0, cancel_calls = 0, terminate_calls = 0, withheld_waits = 0;
};
std::mutex lock;
std::condition_variable changed;
std::array<Record,64> records;
unsigned count = 0;
thread_local Record *owner_record = nullptr;
Record &record(const void *b) {
    // Latest registration wins if an allocator reuses an already deleted address.
    for (unsigned i = count; i; i--) if (records[i-1].bridge == b) return records[i-1];
    assert(!"unregistered bridge"); return records[0];
}
Record &environment(napi_env env) {
    for (unsigned i = count; i; i--) if (records[i-1].env == env) return records[i-1];
    assert(!"unregistered environment"); return records[0];
}
bool live_fault(const Record &r) { return r.fault == BUFFER_LIVE || r.fault == BUFFER_LIVE_EXCEPTION; }
bool dual_fault(const Record &r) { return r.armed.find("two-slot") != std::string::npos; }
Record *selected(napi_env env, napi_callback_info info, bool required = false) {
    napi_value arg; size_t argc = 1; void *data;
    assert(napi_get_cb_info(env,info,&argc,&arg,nullptr,&data) == napi_ok);
    if (!argc && !required) return static_cast<Record *>(data);
    unsigned token = 0;
    assert(argc == 1 && napi_get_value_uint32(env,arg,&token) == napi_ok);
    std::lock_guard<std::mutex> guard(lock);
    assert(token && token <= count); return &records[token-1];
}
napi_value undef(napi_env env) { napi_value v; napi_get_undefined(env,&v); return v; }
napi_value arm(napi_env env, napi_callback_info info) {
    napi_value arg; size_t argc = 1; char text[64]; size_t size; void *data;
    assert(napi_get_cb_info(env,info,&argc,&arg,nullptr,&data) == napi_ok && argc == 1);
    assert(napi_get_value_string_utf8(env,arg,text,sizeof(text),&size) == napi_ok);
    auto *r = static_cast<Record *>(data);
    { std::lock_guard<std::mutex> guard(lock);
      r->armed = text; r->reached = r->released = false; r->fault = NONE;
      if (r->armed == "post-start") r->fault = POST_START;
      if (r->armed == "pre-start") r->fault = PRE_START;
      if (r->armed == "unknown-start") r->fault = UNKNOWN_START;
      if (r->armed == "unknown-wait") r->fault = UNKNOWN_WAIT;
      if (r->armed == "destroy-failure") r->fault = DESTROY_FAILURE;
      if (r->armed == "closing") r->fault = CLOSING;
      if (r->armed == "buffer-copy-failure") r->fault = BUFFER_COPY;
      if (r->armed == "buffer-copy-pending-exception") r->fault = BUFFER_EXCEPTION;
      if (r->armed.find("buffer-copy-live") == 0 || r->armed.find("buffer-copy-two-slot") == 0) r->fault = BUFFER_LIVE;
      if (r->armed == "buffer-copy-live-pending-exception") r->fault = BUFFER_LIVE_EXCEPTION;
    }
    napi_value token; napi_create_uint32(env,r->token,&token); return token;
}
napi_value release(napi_env env, napi_callback_info info) {
    Record *r = selected(env,info);
    { std::lock_guard<std::mutex> guard(lock);
      r->released = true; if (++r->release_calls >= 2) r->wait_released = true; changed.notify_all(); }
    return undef(env);
}
napi_value status(napi_env env, napi_callback_info info) {
    Record *r = selected(env,info); Record copy;
    { std::lock_guard<std::mutex> guard(lock); copy = *r; }
    napi_value obj,v; napi_create_object(env,&obj);
    for (auto item : {std::pair<const char *,unsigned>{"token",copy.token},{"cleanup",copy.cleanup},
        {"finalized",copy.finalized},{"ownerDone",copy.owner_done},{"deleted",copy.deleted},
        {"completionClosed",copy.completion_closed},{"closing",copy.closing},
        {"callsAfterClosing",copy.tsfn_calls_after_closing},
        {"bufferFailures",copy.buffer_failures},{"resolved",copy.resolved},{"rejected",copy.rejected},
        {"cancelCalls",copy.cancel_calls},{"terminateCalls",copy.terminate_calls},{"withheldWaits",copy.withheld_waits},
        {"sessionsRetained",static_cast<unsigned>(copy.retained.sessions)},
        {"capacityRetained",static_cast<unsigned>(copy.retained.capacity_bytes)},
        {"sendReserved",static_cast<unsigned>(copy.retained.reserved_send_bytes)}}) {
        napi_create_uint32(env,item.second,&v); napi_set_named_property(env,obj,item.first,v);
    }
    for (auto item : {std::pair<const char *,bool>{"reached",copy.reached},{"destroyFailed",copy.destroy_failed},
        {"destroyRecovered",copy.destroy_recovered},{"exitPublished",copy.exit_published},
        {"batchReady",copy.batch_ready},{"injectedAlive",copy.injected_alive}}) {
        napi_get_boolean(env,item.second,&v); napi_set_named_property(env,obj,item.first,v);
    }
    return obj;
}
}
extern "C" void pw_napi_test_register(const void *b) {
    std::lock_guard<std::mutex> guard(lock); assert(count < records.size());
    Record &r = records[count++]; r.bridge = b; r.token = count;
}
extern "C" void pw_napi_test_point(const void *b, const char *point) {
    std::unique_lock<std::mutex> guard(lock); auto &r = record(b);
    if (!strcmp(point,"owner-enter")) { owner_record = &r; return; }
    if (live_fault(r)) {
        if (!strcmp(point,"owner-tick")) {
            if (!r.batch_ready && r.batch_reads == (dual_fault(r) ? 2u : 1u) &&
                r.target_live && (!dual_fault(r) || r.other_live)) {
                r.batch_ready = true; changed.notify_all();
            }
            if (r.exit_observed) r.exit_published = true;
        }
        if (!strcmp(point,"dispatch-start"))
            assert(changed.wait_for(guard,std::chrono::seconds(2),[&r]{return r.batch_ready;}));
    }
    if (r.fault == BUFFER_COPY || r.fault == BUFFER_EXCEPTION) {
        // Block dispatch BEFORE taking Shared, not while holding Bridge::mutex.
        // owner-tick is after both op_done and the real waitpid exit publication.
        if (!strcmp(point,"owner-tick") && r.exit_observed) {
            r.exit_published = true; changed.notify_all();
        }
        if (!strcmp(point,"dispatch-start")) {
            assert(changed.wait_for(guard,std::chrono::seconds(2),[&r]{return r.exit_published;}));
        }
    }
    if (!strcmp(point,"bridge-delete")) {
        assert(r.owner_done && r.finalized && r.completion_closed);
        assert(!r.destroy_failed || r.destroy_recovered);
        r.deleted = ++r.sequence; return;
    }
    if (!strcmp(point,"owner-done")) {
        assert(!r.destroy_failed || r.destroy_recovered);
        r.owner_done = ++r.sequence; return;
    }
    if (!strcmp(point,"tsfn-finalized")) { r.finalized = ++r.sequence; return; }
    if (!strcmp(point,"cleanup-start")) { r.cleanup = ++r.sequence; return; }
    if (!strcmp(point,"completion-closed")) { r.completion_closed = ++r.sequence; return; }
    if (!strcmp(point,"tsfn-closing")) { r.closing = ++r.sequence; return; }
    if (r.armed == point && !r.reached) {
        r.reached = true; changed.notify_all();
        changed.wait(guard,[&r]{return r.released;}); assert(!r.deleted);
    }
}
extern "C" int pw_napi_regression_start(pw_root *r, uint64_t deadline, pw_session **s) {
    assert(owner_record); Fault f;
    { std::lock_guard<std::mutex> guard(lock); f = owner_record->fault; }
    if (f == UNKNOWN_START) { *s = nullptr; return PW_SYSTEM; }
    if (f == PRE_START) assert(pw_fixture_fail_at(r,PW_FAULT_PIPE_1) == PW_OK);
    int rc = pw_start(r,deadline,s);
    return f == POST_START && rc == PW_OK ? PW_SYSTEM : rc;
}
extern "C" int pw_napi_regression_wait(pw_session *s) {
    assert(owner_record);
    { std::lock_guard<std::mutex> guard(lock);
      if (!owner_record->released && owner_record->fault == POST_START) return PW_AGAIN;
      if (!owner_record->released && owner_record->fault == UNKNOWN_WAIT) return PW_SYSTEM;
      if (live_fault(*owner_record) && s == owner_record->failed_session &&
          owner_record->target_cancelled && !owner_record->wait_released) {
          owner_record->withheld_waits++; return PW_SYSTEM;
      }
    }
    int rc = pw_observe_direct_exit(s);
    { std::lock_guard<std::mutex> guard(lock);
      auto &r = *owner_record;
      if (live_fault(r)) {
          if (rc == PW_AGAIN && s == r.failed_session) r.target_live = true;
          if (rc == PW_AGAIN && s == r.other_session) r.other_live = true;
          if (rc == PW_OK && s == r.failed_session) r.exit_observed = true;
      } else if (r.read_completed && rc == PW_OK) r.exit_observed = true; }
    return rc;
}
extern "C" int pw_napi_regression_read(pw_session *s, const unsigned char **p, size_t *n) {
    int rc = pw_read_frame_step(s,p,n);
    bool terminate = false;
    { std::lock_guard<std::mutex> guard(lock);
      if (rc == PW_OK && (owner_record->fault == BUFFER_COPY || owner_record->fault == BUFFER_EXCEPTION)) {
          owner_record->read_completed = true; terminate = true;
      }
      if (rc == PW_OK && live_fault(*owner_record) && !owner_record->batch_ready) {
          assert(*n == 4); auto &r = *owner_record; r.batch_reads++;
          if (!memcmp(*p,"FAIL",4)) r.failed_session = s;
          else { assert(!memcmp(*p,"SAFE",4)); r.other_session = s; }
      }
    }
    // Retain the actual successful read, then terminate only this fixture child.
    // The normal owner wait path must still observe and publish its real exit.
    if (terminate) assert(pw_terminate_direct_child(s) == PW_OK);
    return rc;
}
extern "C" napi_status pw_napi_regression_buffer_copy(napi_env env, size_t n, const void *p, void **copy, napi_value *value) {
    bool inject = false, pending = false;
    { std::lock_guard<std::mutex> guard(lock); auto &r = environment(env);
      inject = (r.fault == BUFFER_COPY || r.fault == BUFFER_EXCEPTION) && !r.buffer_failures;
      if (live_fault(r) && n == 4 && !memcmp(p,"FAIL",4) && !r.buffer_failures) {
          assert(r.batch_ready && r.target_live && !r.exit_observed);
          r.injected_alive = true; inject = true;
      }
      if (inject) {
          assert(live_fault(r) || (r.exit_published && r.read_completed && n)); r.buffer_failures++;
          pending = r.fault == BUFFER_EXCEPTION || r.fault == BUFFER_LIVE_EXCEPTION;
      }
    }
    if (!inject) return napi_create_buffer_copy(env,n,p,copy,value);
    if (pending) {
        assert(napi_throw_error(env,"INJECTED_BUFFER_COPY","controlled allocation failure") == napi_ok);
        return napi_pending_exception;
    }
    return napi_generic_failure;
}
extern "C" int pw_napi_regression_cancel(pw_session *s) {
    { std::lock_guard<std::mutex> guard(lock); auto &r = *owner_record;
      if (live_fault(r) && s == r.failed_session) { r.cancel_calls++; r.target_cancelled = true; } }
    return pw_cancel(s);
}
extern "C" int pw_napi_regression_terminate(pw_session *s) {
    { std::lock_guard<std::mutex> guard(lock); auto &r = *owner_record;
      if (live_fault(r) && s == r.failed_session) r.terminate_calls++; }
    return pw_terminate_direct_child(s);
}
extern "C" napi_status pw_napi_regression_resolve(napi_env env, napi_deferred d, napi_value value) {
    { std::lock_guard<std::mutex> guard(lock); environment(env).resolved++; }
    napi_status rc = napi_resolve_deferred(env,d,value); assert(rc == napi_ok); return rc;
}
extern "C" napi_status pw_napi_regression_reject(napi_env env, napi_deferred d, napi_value value) {
    { std::lock_guard<std::mutex> guard(lock); environment(env).rejected++; }
    napi_status rc = napi_reject_deferred(env,d,value); assert(rc == napi_ok); return rc;
}
extern "C" int pw_napi_regression_destroy(pw_root *root) {
    assert(owner_record); auto &r = *owner_record;
    pw_snapshot_v2 snapshot{}; assert(pw_inspect_v2(root,nullptr,PW_SNAPSHOT_ABI_V2,sizeof(pw_snapshot_v2),&snapshot) == PW_OK);
    {
        std::lock_guard<std::mutex> guard(lock);
        if (r.fault == DESTROY_FAILURE) {
            if (!r.released) {
                r.failed_root = root; r.retained = snapshot; r.destroy_failed = true; return PW_SYSTEM;
            }
            assert(root == r.failed_root);
            assert(snapshot.sessions == r.retained.sessions && snapshot.capacity_bytes == r.retained.capacity_bytes);
            assert(snapshot.reserved_send_bytes == r.retained.reserved_send_bytes && snapshot.charges_retained);
        }
    }
    int rc = pw_root_destroy(root);
    if (rc == PW_OK && r.destroy_failed) { std::lock_guard<std::mutex> guard(lock); r.destroy_recovered = true; }
    return rc;
}
extern "C" napi_status pw_napi_regression_call(napi_threadsafe_function fn, void *data, napi_threadsafe_function_call_mode mode) {
    assert(owner_record); bool abort = false;
    { std::lock_guard<std::mutex> guard(lock);
      if (owner_record->closing) owner_record->tsfn_calls_after_closing++;
      abort = owner_record->fault == CLOSING && !owner_record->closing;
    }
    // Actual abort/closing transition in a controlled test build, not a fake
    // successful cancellation and not a production enablement path.
    if (abort) {
        // Leave one counted user for Push's closing path to consume. Without
        // this acquire, abort drops the last user and Push is invalid-arg,
        // which is not evidence that napi_closing was exercised.
        assert(napi_acquire_threadsafe_function(fn) == napi_ok);
        assert(napi_release_threadsafe_function(fn,napi_tsfn_abort) == napi_ok);
    }
    napi_status rc = napi_call_threadsafe_function(fn,data,mode);
    { std::unique_lock<std::mutex> guard(lock); auto &r = *owner_record;
      // Queue the real wake BEFORE pausing the owner, so JS can consume the
      // successful read while the real peer is still alive and no kill ran.
      if (live_fault(r) && r.batch_ready && !r.released)
          assert(changed.wait_for(guard,std::chrono::seconds(2),[&r]{return r.released;}));
    }
    return rc;
}
extern "C" void pw_napi_test_exports(napi_env env, napi_value exports, const void *b) {
    Record *r;
    { std::lock_guard<std::mutex> guard(lock); r = &record(b); r->env = env; }
    for (auto item : {std::pair<const char *,napi_callback>{"testArm",arm},{"testRelease",release},{"testStatus",status}}) {
        napi_value fn; napi_create_function(env,item.first,NAPI_AUTO_LENGTH,item.second,r,&fn);
        napi_set_named_property(env,exports,item.first,fn);
    }
}
