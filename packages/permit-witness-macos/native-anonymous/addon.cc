// Independent development bridge. No fd/PID/path export and no JS callbacks on
// the owner thread. No event-loop I/O, watchdog, OS identity or tree-exit claim.
#define NAPI_VERSION 8
#include <node_api.h>
extern "C" {
#include "anonymous.h"
}
#include <array>
#include <cstring>
#include <mutex>
#include <new>
#include <thread>
#include <chrono>
#include <atomic>
#include <uv.h>

#ifdef PW_NAPI_COMBINED_FIXTURE
#if !defined(PW_NAPI_FIXTURE) || !defined(PW_ANONYMOUS_FIXTURE) || !defined(PW_ANONYMOUS_STATE_FIXTURE)
#error "combined N-API is a separately compiled development fixture only"
#endif
extern "C" {
#include "combined-session.h"
}
#include <memory>
#ifdef PW_NAPI_CS_REGRESSION
extern "C" void pw_cs_test_register(napi_env,const void *,uv_async_t *);
extern "C" void pw_cs_test_point(const void *,const char *);
extern "C" bool pw_cs_test_fail(const void *,const char *);
extern "C" void pw_cs_test_exports(napi_env,napi_value,const void *);
#define CS_TEST(b,p) pw_cs_test_point(b,p)
#define CS_FAIL(b,p) pw_cs_test_fail(b,p)
#else
#define CS_TEST(b,p) ((void)0)
#define CS_FAIL(b,p) false
#endif
#endif

#if defined(PW_NAPI_FIXTURE) && !defined(PW_ANONYMOUS_FIXTURE)
#error "N-API test enablement requires a separately compiled fixture core"
#endif

#ifdef PW_NAPI_REGRESSION
#ifndef PW_NAPI_FIXTURE
#error "regression barriers are fixture-only"
#endif
extern "C" void pw_napi_test_register(const void *);
extern "C" void pw_napi_test_point(const void *, const char *);
extern "C" void pw_napi_test_exports(napi_env, napi_value, const void *);
#define TEST_POINT(b,point) pw_napi_test_point(b,point)
#else
#define TEST_POINT(b,point) ((void)0)
#endif

#ifndef PW_NAPI_COMBINED_FIXTURE
struct Bridge;
struct Shared {
    bool start = false, cancel = false, terminate = false, busy = true;
    int command = 0; // 1 read, 2 write
    std::array<unsigned char, PW_FRAME_MAX> input{}, result{};
    size_t input_size = 0, result_size = 0;
    bool ready_done = false, op_done = false, exit_done = false;
    int ready_rc = PW_OK, op_rc = PW_OK;
    pw_snapshot_v2 snapshot{};
    bool not_started = false;
};
struct Slot {
    Bridge *bridge = nullptr;
    Shared shared;
    // Only the owner thread accesses native state below.
    pw_session *native = nullptr;
    int phase = 0; // 1 handshake, 2 read, 3 write
    bool exit_reported = false;
    bool launch_unknown = false;
    // Only the JS thread accesses these deferreds.
    napi_deferred ready = nullptr, operation = nullptr, direct_exit = nullptr;
    bool delivery_failed = false; // terminal admission latch before Promise hooks
};
struct Bridge {
    std::mutex mutex;
    std::mutex wake_mutex; // only nonblocking TSFN calls/finalization, no JS
    std::array<Slot, PW_SESSION_MAX> slots;
    size_t admitted = 0;
    bool stopping = false;
    // Owner-thread lifetime: failed destruction must keep the actual root and
    // its accounting reachable. JS sees only copied cleanup state, never root.
    pw_root *retained_root = nullptr;
    int cleanup_error = PW_OK;
    pw_snapshot_v2 retained_account{};
    napi_threadsafe_function wake = nullptr;
    napi_async_cleanup_hook_handle cleanup = nullptr;
    uv_async_t completion{};
    std::atomic<unsigned> references{3}; // owner, TSFN, independent uv completion
    std::atomic<bool> owner_done{false}, tsfn_done{false};
    ~Bridge() { TEST_POINT(this,"bridge-delete"); }
};
static void release_bridge(Bridge *b) {
    if (b->references.fetch_sub(1) == 1) delete b;
}
static void completion_closed(uv_handle_t *handle) {
    auto *b = static_cast<Bridge *>(handle->data);
    TEST_POINT(b,"completion-closed");
    if (b->cleanup) napi_remove_async_cleanup_hook(b->cleanup);
    release_bridge(b);
}
static void completion_ready(uv_async_t *handle) {
    auto *b = static_cast<Bridge *>(handle->data);
    std::lock_guard<std::mutex> guard(b->mutex);
    if (b->owner_done.load() && b->tsfn_done.load() &&
        !uv_is_closing(reinterpret_cast<uv_handle_t *>(handle)))
        uv_close(reinterpret_cast<uv_handle_t *>(handle),completion_closed);
}
static const napi_type_tag tag = { 0x82f816b667b5d240ULL, 0xb3e06193aeab35d7ULL };
static napi_value undefined(napi_env env) { napi_value v; napi_get_undefined(env,&v); return v; }
static napi_value fail(napi_env env, const char *code) {
    napi_throw_error(env,code,code); return nullptr;
}
static napi_value error(napi_env env, int rc) {
    napi_value text, e; napi_create_string_utf8(env,pw_result_name(rc),NAPI_AUTO_LENGTH,&text);
    napi_create_error(env,text,text,&e); return e;
}
static void settle(napi_env env, napi_deferred &d, int rc, napi_value value) {
    if (!d) return;
    napi_deferred pending = d; d = nullptr; // hooks may reenter while settling
    if (rc == PW_OK) napi_resolve_deferred(env,pending,value);
    else napi_reject_deferred(env,pending,error(env,rc));
}
static void number(napi_env env, napi_value object, const char *key, size_t n) {
    napi_value v; napi_create_double(env,static_cast<double>(n),&v); napi_set_named_property(env,object,key,v);
}
static void boolean(napi_env env, napi_value object, const char *key, bool b) {
    napi_value v; napi_get_boolean(env,b,&v); napi_set_named_property(env,object,key,v);
}
static void dispatch(napi_env env, napi_value, void *context, void *) {
    if (!env) return; // Environment teardown: no JS or late result delivery.
    auto *b = static_cast<Bridge *>(context);
    for (auto &s : b->slots) {
        Shared copy;
        TEST_POINT(b,"dispatch-start");
        {
            std::lock_guard<std::mutex> guard(b->mutex);
            copy = s.shared;
            s.shared.ready_done = s.shared.op_done = s.shared.exit_done = false;
            if (copy.ready_done || copy.op_done) s.shared.busy = false;
            s.shared.result.fill(0);
        }
        if (copy.ready_done) settle(env,s.ready,copy.ready_rc,undefined(env));
        if (copy.op_done) {
            napi_value value = undefined(env);
            if (copy.op_rc == PW_OK && copy.result_size) {
                if (napi_create_buffer_copy(env,copy.result_size,copy.result.data(),nullptr,&value) != napi_ok) {
                    // Fail this channel before rejection hooks can reenter io.
                    // Only the owner closes native fds/terminates/reaps the child.
                    s.delivery_failed = true;
                    { std::lock_guard<std::mutex> guard(b->mutex);
                      s.shared.cancel = true; s.shared.terminate = true; }
                    // Clear a possible allocation exception before rejecting,
                    // and still deliver an exit already taken from Shared.
                    napi_value exception; napi_get_and_clear_last_exception(env,&exception);
                    copy.op_rc = PW_SYSTEM; value = undefined(env);
                }
            }
            { std::lock_guard<std::mutex> guard(b->mutex);
              if (!s.delivery_failed && (s.shared.cancel || b->stopping)) copy.op_rc = PW_CANCELLED; }
            settle(env,s.operation,copy.op_rc,value);
        }
        if (copy.exit_done) {
            napi_value value; napi_create_object(env,&value);
            boolean(env,value,"directExitObserved",copy.snapshot.direct_exit_observed);
            boolean(env,value,"treeExitProven",false);
            boolean(env,value,"notStarted",copy.not_started);
            number(env,value,"status",static_cast<size_t>(copy.snapshot.direct_exit_status));
            napi_object_freeze(env,value);
            settle(env,s.direct_exit,PW_OK,value);
        }
    }
    bool pending = false;
    for (const auto &s : b->slots) pending |= s.ready || s.operation || s.direct_exit;
    if (!pending) napi_unref_threadsafe_function(env,b->wake);
}
static void publish_ready(Slot &s, int rc) {
    TEST_POINT(s.bridge,"ready-publication");
    std::lock_guard<std::mutex> guard(s.bridge->mutex);
    if (s.shared.cancel || s.bridge->stopping) rc = PW_CANCELLED;
    s.shared.ready_done = true; s.shared.ready_rc = rc;
}
static void publish_op(Slot &s, int rc, const unsigned char *p = nullptr, size_t n = 0) {
    TEST_POINT(s.bridge,"op-publication");
    std::lock_guard<std::mutex> guard(s.bridge->mutex);
    if (s.shared.cancel || s.bridge->stopping) rc = PW_CANCELLED;
    s.shared.op_done = true; s.shared.op_rc = rc;
    s.shared.result_size = rc == PW_OK ? n : 0;
    if (rc == PW_OK && n) std::memcpy(s.shared.result.data(),p,n);
}
static void owner_loop(Bridge *b) {
    TEST_POINT(b,"owner-enter");
    pw_root *root = pw_root_create();
    b->retained_root = root;
    bool tsfn_open = true;
    for (;;) {
        bool stopping;
        { std::lock_guard<std::mutex> guard(b->mutex); stopping = b->stopping; }
        bool all_reaped = true;
        for (auto &s : b->slots) {
            bool start, cancel, terminate; int command; size_t n;
            std::array<unsigned char,PW_FRAME_MAX> bytes{};
            {
                std::lock_guard<std::mutex> guard(b->mutex);
                start = s.shared.start; s.shared.start = false;
                cancel = s.shared.cancel; // persistent terminal arbitration
                terminate = s.shared.terminate; s.shared.terminate = false;
                command = s.shared.command; s.shared.command = 0;
                n = s.shared.input_size;
                if (command == 2) { bytes = s.shared.input; s.shared.input.fill(0); }
            }
            if (start) {
                int rc = root ? pw_start(root,pw_now_ns()+3000000000ULL,&s.native) : PW_UNSUPPORTED;
                if (rc == PW_OK) s.phase = 1;
                else {
                    publish_ready(s,rc);
                    pw_snapshot_v2 snapshot{};
                    bool known = s.native && pw_inspect_v2(root,s.native,PW_SNAPSHOT_ABI_V2,sizeof(pw_snapshot_v2),&snapshot) == PW_OK;
                    bool not_started = known && !snapshot.launch_started && !snapshot.lifecycle_unknown;
                    if (!s.native && (rc == PW_UNSUPPORTED || rc == PW_UNSAFE_DEPLOYMENT ||
                        rc == PW_ADMISSION || rc == PW_DEADLINE)) not_started = true;
                    s.launch_unknown = !known && !not_started;
                    if (not_started) {
                        std::lock_guard<std::mutex> guard(b->mutex);
                        s.shared.not_started = true; s.shared.exit_done = true; s.exit_reported = true;
                    }
                }
            }
            if (s.native) {
                if (stopping || cancel) {
                    pw_cancel(s.native);
                    if (s.phase == 1) publish_ready(s,PW_CANCELLED);
                    else if (s.phase) publish_op(s,PW_CANCELLED);
                    s.phase = 0;
                }
                if (stopping || terminate) pw_terminate_direct_child(s.native);
                if (command && !s.phase) {
                    if (cancel || stopping) publish_op(s,PW_CANCELLED);
                    else if (command == 1) s.phase = 2;
                    else {
                        int rc = pw_write_frame_begin(s.native,bytes.data(),n);
                        if (rc == PW_OK) s.phase = 3; else publish_op(s,rc);
                    }
                }
                int rc = PW_AGAIN;
                const unsigned char *p = nullptr; size_t size = 0;
                if (s.phase == 1) rc = pw_handshake_step(s.native);
                if (s.phase == 2) rc = pw_read_frame_step(s.native,&p,&size);
                if (s.phase == 3) rc = pw_write_step(s.native);
                if (s.phase && rc != PW_AGAIN) {
                    if (s.phase == 1) publish_ready(s,rc); else publish_op(s,rc,p,size);
                    s.phase = 0;
                }
                int wait_rc = pw_observe_direct_exit(s.native);
                pw_snapshot_v2 snapshot{}; pw_inspect_v2(root,s.native,PW_SNAPSHOT_ABI_V2,sizeof(pw_snapshot_v2),&snapshot);
                {
                    std::lock_guard<std::mutex> guard(b->mutex);
                    s.shared.snapshot = snapshot;
                    if (!s.exit_reported && wait_rc == PW_OK && snapshot.direct_exit_observed) {
                        s.shared.exit_done = true; s.exit_reported = true;
                    }
                }
                if (snapshot.launch_started && !snapshot.direct_exit_observed) all_reaped = false;
            } else if (command) publish_op(s,PW_CLOSED);
            if (s.launch_unknown) all_reaped = false;
        }
        if (stopping && all_reaped) {
            pw_snapshot_v2 account{};
            if (root) pw_inspect_v2(root,nullptr,PW_SNAPSHOT_ABI_V2,sizeof(pw_snapshot_v2),&account);
            int rc = root ? pw_root_destroy(root) : PW_OK;
            if (rc == PW_OK) {
                b->retained_root = nullptr; root = nullptr;
                break;
            }
            // No owner completion, hook removal, pointer loss or budget refund
            // on failed cleanup. Retry on the same owner and exact same root;
            // a permanent unknown state deliberately keeps teardown pending.
            { std::lock_guard<std::mutex> guard(b->mutex);
              b->cleanup_error = rc; b->retained_account = account; }
            TEST_POINT(b,"root-destroy-failed");
        }
        TEST_POINT(b,"owner-tick");
        // A one-item nonblocking wake queue carries no payload. Completed data
        // stays in two fixed slots until JS consumes it; no TSFN result queue.
        // napi_closing ends our TSFN ownership: never call/release it again.
        if (tsfn_open) {
            std::lock_guard<std::mutex> guard(b->wake_mutex);
            if (b->tsfn_done.load()) tsfn_open = false;
            else {
                napi_status status = napi_call_threadsafe_function(b->wake,nullptr,napi_tsfn_nonblocking);
                if (status == napi_closing) { TEST_POINT(b,"tsfn-closing"); tsfn_open = false; }
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    TEST_POINT(b,"owner-done");
    { std::lock_guard<std::mutex> guard(b->wake_mutex);
      if (tsfn_open && !b->tsfn_done.load()) napi_release_threadsafe_function(b->wake,napi_tsfn_release); }
    { std::lock_guard<std::mutex> guard(b->mutex);
      b->owner_done.store(true); uv_async_send(&b->completion); }
    release_bridge(b); // independent owner reference; last access on this thread
}
static void cleanup(napi_async_cleanup_hook_handle handle, void *data) {
    auto *b = static_cast<Bridge *>(data);
    TEST_POINT(b,"cleanup-start");
    { std::lock_guard<std::mutex> guard(b->mutex);
      b->cleanup = handle; b->stopping = true; }
    uv_ref(reinterpret_cast<uv_handle_t *>(&b->completion));
    uv_async_send(&b->completion);
}
static void finalized(napi_env, void *data, void *) {
    auto *b = static_cast<Bridge *>(data);
    TEST_POINT(b,"tsfn-finalized");
    { std::lock_guard<std::mutex> wake_guard(b->wake_mutex);
      std::lock_guard<std::mutex> guard(b->mutex);
      b->tsfn_done.store(true); uv_async_send(&b->completion); }
    release_bridge(b);
}
static Slot *receiver(napi_env env, napi_callback_info info, size_t *argc, napi_value *argv) {
    napi_value self; void *data; bool valid = false;
    if (napi_get_cb_info(env,info,argc,argv,&self,&data) != napi_ok ||
        napi_check_object_type_tag(env,self,&tag,&valid) != napi_ok || !valid) {
        fail(env,"CAPABILITY"); return nullptr;
    }
    Slot *s = nullptr;
    if (napi_unwrap(env,self,reinterpret_cast<void **>(&s)) != napi_ok || !s || s->bridge != data) {
        fail(env,"CAPABILITY"); return nullptr;
    }
    return s;
}
static napi_value operation(napi_env env, napi_callback_info info) {
    napi_value args[2]; size_t argc = 2;
    Slot *s = receiver(env,info,&argc,args); if (!s) return nullptr;
    if (s->delivery_failed) return fail(env,"CLOSED");
    bool write = argc == 1;
    if (argc > 1) return fail(env,"ARGUMENTS");
    void *p = nullptr; size_t n = 0; bool buffer = false;
    if (write && (napi_is_buffer(env,args[0],&buffer) != napi_ok || !buffer ||
        napi_get_buffer_info(env,args[0],&p,&n) != napi_ok || !n || n > PW_FRAME_MAX)) return fail(env,"LENGTH");
    bool busy;
    { std::lock_guard<std::mutex> guard(s->bridge->mutex);
      busy = s->bridge->stopping || s->shared.busy;
      if (!busy) s->shared.busy = true; }
    if (busy) return fail(env,"BUSY");
    // Reserve the bounded slot before creating a Promise; init hooks may call
    // snapshot/cancel/io again. Copy JS-owned bytes before those hooks run.
    std::array<unsigned char,PW_FRAME_MAX> bytes{};
    if (write) std::memcpy(bytes.data(),p,n);
    napi_value promise; napi_deferred deferred;
    if (napi_create_promise(env,&deferred,&promise) != napi_ok) {
        std::lock_guard<std::mutex> guard(s->bridge->mutex); s->shared.busy = false; return nullptr;
    }
    s->operation = deferred;
    {
        std::lock_guard<std::mutex> guard(s->bridge->mutex);
        s->shared.command = write ? 2 : 1;
        s->shared.input_size = n;
        if (write) s->shared.input = bytes;
    }
    napi_ref_threadsafe_function(env,s->bridge->wake);
    return promise;
}
static napi_value control(napi_env env, napi_callback_info info) {
    napi_value args[2]; size_t argc = 2;
    Slot *s = receiver(env,info,&argc,args); if (!s) return nullptr;
    if (argc != 1) return fail(env,"ARGUMENTS");
    bool terminate;
    if (napi_get_value_bool(env,args[0],&terminate) != napi_ok) return fail(env,"ARGUMENTS");
    {
    std::lock_guard<std::mutex> guard(s->bridge->mutex);
    s->shared.cancel = true; s->shared.terminate |= terminate;
    if (s->shared.ready_done) s->shared.ready_rc = PW_CANCELLED;
    if (s->shared.op_done) {
        s->shared.op_rc = PW_CANCELLED; s->shared.result_size = 0; s->shared.result.fill(0);
    }
    }
    return undefined(env);
}
static napi_value inspect(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value arg;
    Slot *s = receiver(env,info,&argc,&arg); if (!s) return nullptr;
    if (argc) return fail(env,"ARGUMENTS");
    pw_snapshot_v2 v; int cleanup_error;
    { std::lock_guard<std::mutex> guard(s->bridge->mutex);
      v = s->shared.snapshot; cleanup_error = s->bridge->cleanup_error; }
    napi_value object; napi_create_object(env,&object);
    number(env,object,"sessionsRetained",v.sessions);
    number(env,object,"capacityBytes",v.capacity_bytes);
    // Reservations are not process RSS measurements. Keep the historical
    // capacityBytes key as the session-buffer reservation alias only.
    number(env,object,"sessionCapacityReservedBytes",v.capacity_bytes);
    number(env,object,"rootCapacityReservedBytes",v.root_capacity_bytes);
    number(env,object,"rootMetadataReservedBytes",v.root_metadata_bytes);
    number(env,object,"traceCapacityReservedBytes",v.trace_capacity_bytes);
    number(env,object,"totalNativeReservedBytes",v.root_capacity_bytes + v.capacity_bytes);
    number(env,object,"snapshotAbiVersion",v.abi_version);
    boolean(env,object,"processRssMeasured",false);
    number(env,object,"receivedBytes",v.received_bytes);
    number(env,object,"sentBytes",v.sent_bytes);
    number(env,object,"reservedSendBytes",v.reserved_send_bytes);
    number(env,object,"terminal",static_cast<size_t>(v.terminal));
    number(env,object,"cleanupError",static_cast<size_t>(cleanup_error));
    boolean(env,object,"directExitObserved",v.direct_exit_observed);
    boolean(env,object,"lifecycleUnknown",v.lifecycle_unknown);
    boolean(env,object,"chargesRetained",true);
    boolean(env,object,"treeExitProven",false);
    boolean(env,object,"executionAuthorized",false);
    boolean(env,object,"watchdog",false);
    boolean(env,object,"osIdentity",false);
    napi_object_freeze(env,object); return object;
}
static napi_value start(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value arg; void *data;
    napi_get_cb_info(env,info,&argc,&arg,nullptr,&data);
    if (argc) return fail(env,"ARGUMENTS");
#ifndef PW_NAPI_FIXTURE
    return fail(env,"UNSAFE_DEPLOYMENT");
#else
    auto *b = static_cast<Bridge *>(data);
    if (!pw_platform_supported()) return fail(env,"UNSUPPORTED");
    if (b->admitted == PW_SESSION_MAX) return fail(env,"ADMISSION");
    Slot &s = b->slots[b->admitted++]; // reserve before Promise hook reentry
    napi_value cap, ready, direct_exit;
    if (napi_create_object(env,&cap) != napi_ok || napi_type_tag_object(env,cap,&tag) != napi_ok ||
        napi_wrap(env,cap,&s,nullptr,nullptr,nullptr) != napi_ok ||
        napi_create_promise(env,&s.ready,&ready) != napi_ok ||
        napi_create_promise(env,&s.direct_exit,&direct_exit) != napi_ok) return nullptr;
    napi_property_descriptor props[] = {
        {"io",nullptr,operation,nullptr,nullptr,nullptr,napi_default,b},
        {"cancel",nullptr,control,nullptr,nullptr,nullptr,napi_default,b},
        {"snapshot",nullptr,inspect,nullptr,nullptr,nullptr,napi_default,b},
        {"ready",nullptr,nullptr,nullptr,nullptr,ready,napi_default,nullptr},
        {"directExit",nullptr,nullptr,nullptr,nullptr,direct_exit,napi_default,nullptr}
    };
    if (napi_define_properties(env,cap,5,props) != napi_ok || napi_object_freeze(env,cap) != napi_ok) return nullptr;
    {
        std::lock_guard<std::mutex> guard(b->mutex);
        s.shared.start = true;
    }
    napi_ref_threadsafe_function(env,b->wake);
    return cap;
#endif
}
NAPI_MODULE_INIT() {
    auto *b = new (std::nothrow) Bridge;
    if (!b) return fail(env,"MEMORY");
#ifdef PW_NAPI_REGRESSION
    pw_napi_test_register(b);
#endif
    for (auto &s : b->slots) s.bridge = b;
    uv_loop_t *loop;
    if (napi_get_uv_event_loop(env,&loop) != napi_ok || uv_async_init(loop,&b->completion,completion_ready)) {
        delete b; return fail(env,"MEMORY");
    }
    b->completion.data = b;
    uv_unref(reinterpret_cast<uv_handle_t *>(&b->completion));
    napi_value name; napi_create_string_utf8(env,"anonymous-owner",NAPI_AUTO_LENGTH,&name);
    if (napi_create_threadsafe_function(env,nullptr,nullptr,name,1,1,b,finalized,b,dispatch,&b->wake) != napi_ok) {
        b->owner_done.store(true); b->tsfn_done.store(true); b->references.store(1);
        uv_close(reinterpret_cast<uv_handle_t *>(&b->completion),completion_closed); return fail(env,"MEMORY");
    }
    if (napi_add_async_cleanup_hook(env,cleanup,b,&b->cleanup) != napi_ok) {
        b->owner_done.store(true); release_bridge(b);
        napi_release_threadsafe_function(b->wake,napi_tsfn_abort); return fail(env,"MEMORY");
    }
    // The owner must not keep an otherwise idle Node process alive. Teardown
    // uses the async hook and real WNOHANG reaping; never join on the JS thread.
    napi_unref_threadsafe_function(env,b->wake);
    try { std::thread(owner_loop,b).detach(); }
    catch (...) {
        b->owner_done.store(true); release_bridge(b);
        napi_release_threadsafe_function(b->wake,napi_tsfn_abort); return fail(env,"THREAD");
    }
    napi_value fn; napi_create_function(env,"start",NAPI_AUTO_LENGTH,start,b,&fn);
    napi_set_named_property(env,exports,"start",fn);
#ifdef PW_NAPI_REGRESSION
    pw_napi_test_exports(env,exports,b);
#endif
    napi_object_freeze(env,exports); return exports;
}
#else // PW_NAPI_COMBINED_FIXTURE: independent fixture API, no legacy io bridge.

namespace {
#ifndef PW_NAPI_COMBINED_COPY_LIMIT
#define PW_NAPI_COMBINED_COPY_LIMIT (64u * 1024u * 1024u)
#endif
#ifndef PW_NAPI_COMBINED_DEADLINE_MS
#define PW_NAPI_COMBINED_DEADLINE_MS 4900
#endif
static_assert(PW_NAPI_COMBINED_COPY_LIMIT > 0 && PW_NAPI_COMBINED_COPY_LIMIT <= 64u*1024u*1024u);
static_assert(PW_NAPI_COMBINED_DEADLINE_MS > 0 && PW_NAPI_COMBINED_DEADLINE_MS <= 4900);
constexpr size_t copy_metadata = 4096; // conservative allowance, NOT allocator/RSS measurement
struct CSBridge;
struct CSSlot {
    CSBridge *bridge = nullptr;
    bool start = false, cancel = false, terminate = false, busy = true;
    bool ready_done = false, op_done = false, exit_done = false, closed_done = false;
    bool not_started = false, result_buffer = false;
#ifdef PW_NAPI_CS_REGRESSION
    bool release_peer = false;
#endif
    const char *failure = nullptr, *ready_error = nullptr, *op_error = nullptr;
    unsigned command = 0;
    uint64_t operation = 0;
    size_t input_size = 0, result_size = 0, pumps = 0;
    std::unique_ptr<unsigned char[]> input, result;
    pw_cs_snapshot_v1 snapshot{};
    // Native owner only. Never inspected or exposed by JS.
    pw_cs_session *native = nullptr;
    unsigned phase = 0; // ready, response, close
    bool exit_reported = false, launch_unknown = false, closed_reported = false;
    // JS thread only; null BEFORE a settlement hook may reenter.
    napi_deferred ready = nullptr, op = nullptr, direct_exit = nullptr, closed = nullptr;
};
struct CSBridge {
    std::mutex mutex, wake_mutex;
    std::array<CSSlot,PW_SESSION_MAX> slots;
    size_t admitted = 0, copy_reserved = 0, input_copies = 0, result_copies = 0, delivered_copies = 0;
    size_t allocations = 0, loops = 0, trace_checked = 0, trace_received = 0;
    bool trace_valid = true, stopping = false;
    int cleanup_error = 0;
    pw_cs_root *retained_root = nullptr; // owner only; retained on destruction failure
    napi_threadsafe_function wake = nullptr;
    napi_async_cleanup_hook_handle cleanup = nullptr;
    uv_async_t completion{};
    std::atomic<unsigned> references{3};
    std::atomic<bool> owner_done{false}, tsfn_done{false};
    ~CSBridge(){CS_TEST(this,"bridge-delete");}
};
static const napi_type_tag cs_tag = {0x35cd96d8fe3049a1ULL,0xd23e7f31459cab80ULL};
static napi_value cs_undefined(napi_env env) { napi_value v; napi_get_undefined(env,&v); return v; }
static napi_value cs_throw(napi_env env,const char *code) { napi_throw_error(env,code,code); return nullptr; }
static void cs_settle(napi_env env,napi_deferred &d,const char *code,napi_value value) {
    if(!d)return; napi_deferred pending=d;d=nullptr;
    if(!code)napi_resolve_deferred(env,pending,value);
    else {napi_value text,e;napi_create_string_utf8(env,code,NAPI_AUTO_LENGTH,&text);napi_create_error(env,text,text,&e);napi_reject_deferred(env,pending,e);}
}
static void cs_num(napi_env env,napi_value obj,const char *key,size_t n) {napi_value v;napi_create_double(env,static_cast<double>(n),&v);napi_set_named_property(env,obj,key,v);}
static void cs_bool(napi_env env,napi_value obj,const char *key,bool n) {napi_value v;napi_get_boolean(env,n,&v);napi_set_named_property(env,obj,key,v);}
// Caller holds mutex. Every accepted allocation/copy is charged BEFORE it,
// including a failed allocation or Buffer delivery. Move transfers add no copy.
static bool cs_charge(CSBridge *b,size_t n,unsigned kind) {
    if(n>PW_SW_MAX_PAYLOAD||n+copy_metadata>PW_NAPI_COMBINED_COPY_LIMIT-b->copy_reserved)return false;
    b->copy_reserved+=n+copy_metadata;b->allocations++;
    if(kind==0)b->input_copies+=n;else if(kind==1)b->result_copies+=n;else b->delivered_copies+=n;
    return true;
}
static void cs_latch(CSSlot &s,const char *reason) {
    // Caller holds mutex. Scope is exactly this slot; owner is notified before
    // rejection hooks run. No JS thread calls native cancel/kill/wait.
    if(!s.failure)s.failure=reason;s.cancel=true;s.terminate=true;
}
static const char *cs_reason(const pw_cs_snapshot_v1 &v) {
    if(v.transport_error)return pw_result_name(v.transport_error);
    if(v.state_error)return pw_ss_code_name_v1(v.state_error);
    return "PROTOCOL";
}
static napi_value cs_snapshot(napi_env env,CSSlot &s) {
    pw_cs_snapshot_v1 v;size_t reserved,in,out,delivered,allocations,pumps,loops,checked;bool valid;int cleanup;const char *failure;
    {std::lock_guard<std::mutex> g(s.bridge->mutex);auto *b=s.bridge;v=s.snapshot;reserved=b->copy_reserved;
     in=b->input_copies;out=b->result_copies;delivered=b->delivered_copies;allocations=b->allocations;pumps=s.pumps;loops=b->loops;
     checked=b->trace_checked;valid=b->trace_valid;cleanup=b->cleanup_error;failure=s.failure;}
    napi_value obj;napi_create_object(env,&obj);
    cs_num(env,obj,"maxWireBytes",PW_SW_MAX_FRAME);cs_num(env,obj,"maxPayloadBytes",PW_SW_MAX_PAYLOAD);
    cs_num(env,obj,"bridgeMetadataReservedBytes",sizeof(CSBridge));cs_num(env,obj,"bridgeCopyReservedBytes",reserved);
    cs_num(env,obj,"bridgeCopyLimit",PW_NAPI_COMBINED_COPY_LIMIT);cs_num(env,obj,"bridgeCopyMetadataAllowance",copy_metadata);
    cs_num(env,obj,"inputCopyReservedPayloadBytes",in);cs_num(env,obj,"resultCopyReservedPayloadBytes",out);cs_num(env,obj,"deliveryCopyReservedPayloadBytes",delivered);
    cs_num(env,obj,"copyAllocationAttempts",allocations);cs_num(env,obj,"ownerPumps",pumps);cs_num(env,obj,"ownerLoops",loops);
    cs_num(env,obj,"traceEntriesChecked",checked);cs_bool(env,obj,"readCreditsValid",valid);
    cs_num(env,obj,"transportCapacityReservedBytes",v.transport.capacity_bytes);
    cs_num(env,obj,"transportRootReservedBytes",v.transport.root_capacity_bytes);
    cs_num(env,obj,"wrapperReservedBytes",v.wrapper_reserved_bytes);cs_num(env,obj,"stateCapacityReservedBytes",v.state.capacity_reserved);
    cs_num(env,obj,"sessionsRetained",v.transport.sessions);cs_num(env,obj,"sentBytes",v.transport.sent_bytes);
    cs_num(env,obj,"receivedBytes",v.transport.received_bytes);cs_num(env,obj,"reservedSendBytes",v.transport.reserved_send_bytes);
    cs_num(env,obj,"stateSentReservedBytes",v.state.sent_reserved);cs_num(env,obj,"stateReceivedBytes",v.state.received_charged);
    cs_num(env,obj,"writeWaits",v.transport.write_waits);cs_num(env,obj,"phase",v.state.phase);
    cs_num(env,obj,"cleanupError",static_cast<size_t>(cleanup));cs_num(env,obj,"openFds",v.transport.open_fds);
    cs_bool(env,obj,"protocolClosed",v.protocol_closed);cs_bool(env,obj,"stateKeyWiped",v.state.key_wiped);
    cs_bool(env,obj,"transportKeyWiped",v.transport.key_wiped);cs_bool(env,obj,"directExitObserved",v.transport.direct_exit_observed);
    cs_bool(env,obj,"sessionKeyHolder",v.state.session_key_holder);cs_bool(env,obj,"chargesRetained",true);
    for(const char *key:{"treeExitProven","executionAuthorized","osIdentity","watchdog","processRssMeasured"})cs_bool(env,obj,key,false);
    napi_value error;if(failure)napi_create_string_utf8(env,failure,NAPI_AUTO_LENGTH,&error);else napi_get_null(env,&error);
    napi_set_named_property(env,obj,"failure",error);napi_object_freeze(env,obj);return obj;
}
static void cs_release(CSBridge *b) {if(b->references.fetch_sub(1)==1)delete b;}
static void cs_completion_closed(uv_handle_t *h) {auto *b=static_cast<CSBridge *>(h->data);CS_TEST(b,"completion-closed");if(b->cleanup)napi_remove_async_cleanup_hook(b->cleanup);cs_release(b);}
static void cs_completion_ready(uv_async_t *h) {
    auto *b=static_cast<CSBridge *>(h->data);CS_TEST(b,"completion-enter");
    // Publication and its final send are one critical section with JS close.
    std::lock_guard<std::mutex> g(b->mutex);
    if(b->owner_done.load()&&b->tsfn_done.load()&&!uv_is_closing(reinterpret_cast<uv_handle_t *>(h)))uv_close(reinterpret_cast<uv_handle_t *>(h),cs_completion_closed);
}
static void cs_dispatch(napi_env env,napi_value,void *context,void *) {
    if(!env)return;auto *b=static_cast<CSBridge *>(context);
    for(auto &s:b->slots){
        bool ready,op,exit,closed,buffer,not_started;const char *ready_error,*op_error;size_t n;int status;
        std::unique_ptr<unsigned char[]> result;
        {std::lock_guard<std::mutex> g(b->mutex);
         ready=s.ready_done;op=s.op_done;exit=s.exit_done;closed=s.closed_done;buffer=s.result_buffer;
         s.ready_done=s.op_done=s.exit_done=s.closed_done=false;if(ready||op)s.busy=false;
         ready_error=s.ready_error;op_error=s.op_error;n=s.result_size;result=std::move(s.result);
         not_started=s.not_started;status=s.snapshot.transport.direct_exit_status;}
        if(ready){
            {std::lock_guard<std::mutex> g(b->mutex);if(s.cancel||b->stopping)ready_error=s.failure?s.failure:"CANCELLED";}
            cs_settle(env,s.ready,ready_error,cs_undefined(env));
        }
        if(op){
            napi_value value=cs_undefined(env);
            {std::lock_guard<std::mutex> g(b->mutex);if(s.cancel&&!op_error)op_error=s.failure?s.failure:"CANCELLED";
             if(!op_error&&buffer&&!cs_charge(b,n,2)){cs_latch(s,"QUOTA");op_error="QUOTA";}}
            if(!op_error&&buffer&&napi_create_buffer_copy(env,n,result.get(),nullptr,&value)!=napi_ok){
                {std::lock_guard<std::mutex> g(b->mutex);cs_latch(s,"SYSTEM");}
                napi_value exception;napi_get_and_clear_last_exception(env,&exception);op_error="SYSTEM";value=cs_undefined(env);
            }
            // Never skip closed/exit already taken from this completion batch.
            cs_settle(env,s.op,op_error,value);
        }
        if(closed)cs_settle(env,s.closed,nullptr,cs_snapshot(env,s));
        if(exit){napi_value value;napi_create_object(env,&value);cs_bool(env,value,"directExitObserved",!not_started);
            cs_bool(env,value,"notStarted",not_started);cs_bool(env,value,"treeExitProven",false);cs_num(env,value,"status",static_cast<size_t>(status));
            napi_object_freeze(env,value);cs_settle(env,s.direct_exit,nullptr,value);}
    }
    bool pending=false;for(const auto &s:b->slots)pending|=s.ready||s.op||s.direct_exit||s.closed;
    if(!pending)napi_unref_threadsafe_function(env,b->wake);
}
static void cs_publish(CSSlot &s,const char *error,bool buffer=false,const unsigned char *p=nullptr,size_t n=0) {
    auto *b=s.bridge;std::unique_ptr<unsigned char[]> result;
    if(!error&&buffer){
        {std::lock_guard<std::mutex> g(b->mutex);if(!cs_charge(b,n,1))error="QUOTA";}
        if(!error&&n){result.reset(new(std::nothrow) unsigned char[n]);if(!result)error="SYSTEM";else std::memcpy(result.get(),p,n);}
    }
    {std::lock_guard<std::mutex> g(b->mutex);
     if(error)cs_latch(s,error);if(s.cancel||b->stopping)error=s.failure?s.failure:"CANCELLED";
     s.op_done=true;s.op_error=error;s.result_buffer=!error&&buffer;s.result_size=error?0:n;s.result=std::move(result);}
}
static void cs_owner(CSBridge *b) {
    CS_TEST(b,"owner-enter");
    pw_cs_root *root=nullptr;int root_rc=pw_cs_root_create_v1(&root);b->retained_root=root;bool tsfn_open=true;size_t first=0;
    for(;;){
        bool stopping,all_reaped=true;
        {std::lock_guard<std::mutex> g(b->mutex);stopping=b->stopping;b->loops++;}
        for(size_t i=0;i<b->slots.size();i++){
            auto &s=b->slots[(first+i)%b->slots.size()];bool start,cancel,kill;unsigned command;uint64_t operation;size_t n;
            std::unique_ptr<unsigned char[]> input;
            {std::lock_guard<std::mutex> g(b->mutex);start=s.start;s.start=false;cancel=s.cancel;kill=s.terminate;s.terminate=false;
             command=s.command;s.command=0;operation=s.operation;n=s.input_size;input=std::move(s.input);}
            if(start){
                int rc=root_rc==PW_CS_OK?pw_cs_start_v1(root,pw_now_ns()+PW_NAPI_COMBINED_DEADLINE_MS*1000000ULL,&s.native):root_rc;
                s.phase=1;
                if(rc!=PW_CS_OK){
                    pw_cs_snapshot_v1 v{};bool known=s.native&&pw_cs_inspect_v1(s.native,&v,sizeof(v))==PW_CS_OK;
                    bool not_started=(!root)||(known&&!v.transport.launch_started&&!v.transport.lifecycle_unknown);
                    s.launch_unknown=!known&&!not_started;
                    std::lock_guard<std::mutex> g(b->mutex);cs_latch(s,"SYSTEM");
                    if(not_started){s.not_started=true;s.exit_done=true;s.exit_reported=true;}
                }
            }
            if(s.native){
#ifdef PW_NAPI_CS_REGRESSION
                bool release_peer;
                {std::lock_guard<std::mutex> g(b->mutex);release_peer=s.release_peer;s.release_peer=false;}
                if(release_peer)pw_cs_resume_fixture_v1(s.native);
#endif
                {std::lock_guard<std::mutex> g(b->mutex);cancel=s.cancel;kill|=s.terminate;s.terminate=false;}
                if(cancel||stopping){pw_cs_abort_v1(s.native);
                    std::lock_guard<std::mutex> g(b->mutex);const char *reason=s.failure?s.failure:"CANCELLED";
                    if(s.phase==1){s.ready_done=true;s.ready_error=reason;}
                    else if(s.phase||command){s.op_done=true;s.op_error=reason;s.result_buffer=false;s.result.reset();}
                    if(!s.closed_reported){s.closed_done=true;s.closed_reported=true;}s.phase=0;command=0;}
                if(kill||stopping)pw_cs_terminate_v1(s.native);
                if(command){int rc=command==1?pw_cs_request_v1(s.native,operation,input.get(),n):pw_cs_close_v1(s.native);
                    if(rc==PW_CS_OK)s.phase=command==1?2:3;
                    else {pw_cs_snapshot_v1 v{};pw_cs_inspect_v1(s.native,&v,sizeof(v));cs_publish(s,cs_reason(v));s.phase=0;}}
                // Pump even when idle. One pump per live slot per turn; no spin
                // until a frame completes, and no copy of input/result on ticks.
                pw_cs_snapshot_v1 before{};pw_cs_inspect_v1(s.native,&before,sizeof(before));
                if(!cancel&&!stopping&&!before.error&&!before.protocol_closed){
                    pw_ss_event_v1 event{};int rc=pw_cs_pump_v1(s.native,&event,sizeof(event));
                    {std::lock_guard<std::mutex> g(b->mutex);s.pumps++;}
                    if(event.event==PW_SS_READY_EVENT){std::lock_guard<std::mutex> g(b->mutex);s.ready_done=true;s.phase=0;}
                    if(event.event==PW_SS_RESPONSE_EVENT){cs_publish(s,nullptr,true,event.payload,event.payload_bytes);s.phase=0;}
                    if(event.event==PW_SS_CLOSED_EVENT){
                        {std::lock_guard<std::mutex> g(b->mutex);s.closed_reported=true;}
                        cs_publish(s,nullptr);s.phase=0;std::lock_guard<std::mutex> g(b->mutex);s.closed_done=true;}
                    if(rc!=PW_CS_OK&&rc!=PW_CS_AGAIN&&rc!=PW_CS_BUSY){pw_cs_snapshot_v1 v{};pw_cs_inspect_v1(s.native,&v,sizeof(v));
                        std::lock_guard<std::mutex> g(b->mutex);cs_latch(s,cs_reason(v));}
                }
                int wait=pw_cs_observe_v1(s.native);pw_cs_snapshot_v1 v{};pw_cs_inspect_v1(s.native,&v,sizeof(v));
                {std::lock_guard<std::mutex> g(b->mutex);s.snapshot=v;
                 if(!s.exit_reported&&wait==PW_OK&&v.transport.direct_exit_observed){s.exit_done=true;s.exit_reported=true;}
                 if(v.transport.launch_started&&!v.transport.direct_exit_observed)all_reaped=false;
                 for(;b->trace_checked<v.transport.trace_count;b->trace_checked++){pw_read_trace trace{};
                     if(pw_cs_trace_v1(root,b->trace_checked,&trace)!=PW_OK||!trace.credit||trace.credit>PW_IO_QUANTUM||
                       trace.credit>trace.phase_remaining||trace.credit>trace.total_remaining||trace.credit!=trace.reserved_before_read||
                       trace.total_remaining!=v.transport.read_limit-b->trace_received||
                       (trace.result>0&&static_cast<size_t>(trace.result)>trace.credit))b->trace_valid=false;
                     if(trace.result>0)b->trace_received+=static_cast<size_t>(trace.result);}}
            }else if(start){std::lock_guard<std::mutex> g(b->mutex);s.ready_done=s.closed_done=true;s.ready_error="SYSTEM";s.phase=0;}
            if(s.launch_unknown)all_reaped=false;
        }
        first=(first+1)%b->slots.size();
        if(stopping&&all_reaped){int rc=root?pw_cs_root_destroy_v1(root):PW_CS_OK;
            if(rc==PW_CS_OK){b->retained_root=nullptr;CS_TEST(b,"root-destroyed");break;}
            std::lock_guard<std::mutex> g(b->mutex);b->cleanup_error=rc;}
        if(tsfn_open){std::lock_guard<std::mutex> wake_guard(b->wake_mutex);
            if(b->tsfn_done.load())tsfn_open=false;
            else if(napi_call_threadsafe_function(b->wake,nullptr,napi_tsfn_nonblocking)==napi_closing)tsfn_open=false;}
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    {std::lock_guard<std::mutex> g(b->wake_mutex);if(tsfn_open&&!b->tsfn_done.load())napi_release_threadsafe_function(b->wake,napi_tsfn_release);}
    CS_TEST(b,"owner-before-done");
    {std::lock_guard<std::mutex> g(b->mutex);b->owner_done.store(true);CS_TEST(b,"owner-published");CS_TEST(b,"owner-sending");uv_async_send(&b->completion);CS_TEST(b,"owner-sent");}
    CS_TEST(b,"owner-release");cs_release(b);
}
static void cs_cleanup(napi_async_cleanup_hook_handle handle,void *data) {auto *b=static_cast<CSBridge *>(data);
    CS_TEST(b,"cleanup-start");
    {std::lock_guard<std::mutex> g(b->mutex);b->cleanup=handle;b->stopping=true;}
    uv_ref(reinterpret_cast<uv_handle_t *>(&b->completion));uv_async_send(&b->completion);}
static void cs_finalized(napi_env,void *data,void *) {auto *b=static_cast<CSBridge *>(data);
    {std::lock_guard<std::mutex> wake_guard(b->wake_mutex);std::lock_guard<std::mutex> g(b->mutex);b->tsfn_done.store(true);uv_async_send(&b->completion);}
    CS_TEST(b,"tsfn-finalized");cs_release(b);}
static CSSlot *cs_receiver(napi_env env,napi_callback_info info,size_t *argc,napi_value *args,void **data=nullptr) {
    napi_value self;void *b;bool valid=false;CSSlot *s=nullptr;
    if(napi_get_cb_info(env,info,argc,args,&self,&b)!=napi_ok||napi_check_object_type_tag(env,self,&cs_tag,&valid)!=napi_ok||!valid||
       napi_unwrap(env,self,reinterpret_cast<void **>(&s))!=napi_ok||!s||s->bridge!=b){cs_throw(env,"CAPABILITY");return nullptr;}
    if(data)*data=b;return s;
}
static napi_value cs_operation(napi_env env,napi_callback_info info,bool request) {
    napi_value args[3];size_t argc=3;CSSlot *s=cs_receiver(env,info,&argc,args);if(!s)return nullptr;
    if((request&&argc!=2)||(!request&&argc!=0))return cs_throw(env,"ARGUMENTS");
    bool buffer=false;double op=0;void *p=nullptr;size_t n=0;
    if(request&&(napi_get_value_double(env,args[0],&op)!=napi_ok||!(op>=1&&op<=65535)||op!=static_cast<uint16_t>(op)||
       napi_is_buffer(env,args[1],&buffer)!=napi_ok||!buffer||napi_get_buffer_info(env,args[1],&p,&n)!=napi_ok))return cs_throw(env,"ARGUMENTS");
    if(n>PW_SW_MAX_PAYLOAD)return cs_throw(env,"LENGTH");
    const char *admission=nullptr;
    {std::lock_guard<std::mutex> g(s->bridge->mutex);if(s->failure||s->cancel||s->closed_reported||s->snapshot.protocol_closed)admission="CLOSED";
     else if(s->bridge->stopping||s->busy)admission="BUSY";
     else {s->busy=true;if(request&&!cs_charge(s->bridge,n,0)){s->busy=false;admission="QUOTA";}}}
    if(admission)return cs_throw(env,admission);
    std::unique_ptr<unsigned char[]> input;
    if(request&&n){input.reset(new(std::nothrow) unsigned char[n]);if(!input){
        {std::lock_guard<std::mutex> g(s->bridge->mutex);cs_latch(*s,"SYSTEM");}return cs_throw(env,"MEMORY");}std::memcpy(input.get(),p,n);}
    napi_value promise;napi_deferred pending;
    if(napi_create_promise(env,&pending,&promise)!=napi_ok){std::lock_guard<std::mutex> g(s->bridge->mutex);cs_latch(*s,"SYSTEM");return nullptr;}
    s->op=pending;
    {std::lock_guard<std::mutex> g(s->bridge->mutex);s->command=request?1:2;s->operation=static_cast<uint64_t>(op);s->input_size=n;s->input=std::move(input);}
    napi_ref_threadsafe_function(env,s->bridge->wake);return promise;
}
static napi_value cs_request(napi_env env,napi_callback_info info){return cs_operation(env,info,true);}
static napi_value cs_close(napi_env env,napi_callback_info info){return cs_operation(env,info,false);}
static napi_value cs_cancel(napi_env env,napi_callback_info info) {napi_value args[2];size_t argc=2;auto *s=cs_receiver(env,info,&argc,args);if(!s)return nullptr;bool kill;
    if(argc!=1||napi_get_value_bool(env,args[0],&kill)!=napi_ok)return cs_throw(env,"ARGUMENTS");
    {std::lock_guard<std::mutex> g(s->bridge->mutex);s->cancel=true;s->terminate|=kill;}return cs_undefined(env);}
static napi_value cs_inspect(napi_env env,napi_callback_info info) {napi_value arg;size_t argc=1;auto *s=cs_receiver(env,info,&argc,&arg);if(!s)return nullptr;if(argc)return cs_throw(env,"ARGUMENTS");return cs_snapshot(env,*s);}
#ifdef PW_NAPI_CS_REGRESSION
static napi_value cs_release_peer(napi_env env,napi_callback_info info){napi_value arg;size_t argc=1;auto *s=cs_receiver(env,info,&argc,&arg);if(!s)return nullptr;
    if(argc)return cs_throw(env,"ARGUMENTS");{std::lock_guard<std::mutex> g(s->bridge->mutex);s->release_peer=true;}return cs_undefined(env);}
#endif
static napi_value cs_start(napi_env env,napi_callback_info info) {napi_value arg;size_t argc=1;void *data;napi_get_cb_info(env,info,&argc,&arg,nullptr,&data);
    if(argc)return cs_throw(env,"ARGUMENTS");auto *b=static_cast<CSBridge *>(data);
    if(!pw_platform_supported())return cs_throw(env,"UNSUPPORTED");if(b->admitted==b->slots.size())return cs_throw(env,"ADMISSION");
    auto &s=b->slots[b->admitted++];napi_value cap,ready,direct,closed;
    if(napi_create_object(env,&cap)!=napi_ok||napi_type_tag_object(env,cap,&cs_tag)!=napi_ok||napi_wrap(env,cap,&s,nullptr,nullptr,nullptr)!=napi_ok||
       napi_create_promise(env,&s.ready,&ready)!=napi_ok||napi_create_promise(env,&s.direct_exit,&direct)!=napi_ok||napi_create_promise(env,&s.closed,&closed)!=napi_ok)return nullptr;
    napi_property_descriptor props[]={
        {"request",nullptr,cs_request,nullptr,nullptr,nullptr,napi_default,b},{"close",nullptr,cs_close,nullptr,nullptr,nullptr,napi_default,b},
        {"cancel",nullptr,cs_cancel,nullptr,nullptr,nullptr,napi_default,b},{"snapshot",nullptr,cs_inspect,nullptr,nullptr,nullptr,napi_default,b},
        {"ready",nullptr,nullptr,nullptr,nullptr,ready,napi_default,nullptr},{"directExit",nullptr,nullptr,nullptr,nullptr,direct,napi_default,nullptr},
        {"closed",nullptr,nullptr,nullptr,nullptr,closed,napi_default,nullptr}
#ifdef PW_NAPI_CS_REGRESSION
        ,{"testReleasePeer",nullptr,cs_release_peer,nullptr,nullptr,nullptr,napi_default,b}
#endif
    };
    if(napi_define_properties(env,cap,sizeof(props)/sizeof(props[0]),props)!=napi_ok||napi_object_freeze(env,cap)!=napi_ok)return nullptr;
    {std::lock_guard<std::mutex> g(b->mutex);s.start=true;}napi_ref_threadsafe_function(env,b->wake);return cap;
}
} // namespace
NAPI_MODULE_INIT() {
    auto *b=new(std::nothrow) CSBridge;if(!b)return cs_throw(env,"MEMORY");for(auto &s:b->slots)s.bridge=b;
#ifdef PW_NAPI_CS_REGRESSION
    pw_cs_test_register(env,b,&b->completion);
#endif
    uv_loop_t *loop;if(CS_FAIL(b,"init-uv")||napi_get_uv_event_loop(env,&loop)!=napi_ok||uv_async_init(loop,&b->completion,cs_completion_ready)){delete b;return cs_throw(env,"MEMORY");}
    b->completion.data=b;uv_unref(reinterpret_cast<uv_handle_t *>(&b->completion));
    napi_value name;napi_create_string_utf8(env,"combined-fixture-owner",NAPI_AUTO_LENGTH,&name);
    if(CS_FAIL(b,"init-tsfn")||napi_create_threadsafe_function(env,nullptr,nullptr,name,1,1,b,cs_finalized,b,cs_dispatch,&b->wake)!=napi_ok){
        b->owner_done.store(true);b->tsfn_done.store(true);b->references.store(1);uv_close(reinterpret_cast<uv_handle_t *>(&b->completion),cs_completion_closed);return cs_throw(env,"MEMORY");}
    if(CS_FAIL(b,"init-cleanup")||napi_add_async_cleanup_hook(env,cs_cleanup,b,&b->cleanup)!=napi_ok){b->owner_done.store(true);cs_release(b);napi_release_threadsafe_function(b->wake,napi_tsfn_abort);return cs_throw(env,"MEMORY");}
    napi_unref_threadsafe_function(env,b->wake);
    try{if(CS_FAIL(b,"init-thread"))throw std::bad_alloc();std::thread(cs_owner,b).detach();}catch(...){b->owner_done.store(true);cs_release(b);napi_release_threadsafe_function(b->wake,napi_tsfn_abort);return cs_throw(env,"THREAD");}
    napi_value fn;napi_create_function(env,"start",NAPI_AUTO_LENGTH,cs_start,b,&fn);napi_set_named_property(env,exports,"start",fn);
#ifdef PW_NAPI_CS_REGRESSION
    pw_cs_test_exports(env,exports,b);
#endif
    napi_object_freeze(env,exports);return exports;
}
#endif // PW_NAPI_COMBINED_FIXTURE
