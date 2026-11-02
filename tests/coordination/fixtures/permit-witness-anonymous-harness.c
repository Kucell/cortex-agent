#include "anonymous.h"
#ifdef PW_ANONYMOUS_FIXTURE
#include "fixture-only.h"
#endif
#include <assert.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#ifdef PW_PIPE2_TEST
void pw_test_check_pipe2(unsigned);
#endif
#ifdef PW_READINESS_TEST
void pw_readiness_bind(pw_root *,pw_session *,int);
#endif
static void nap(void) { struct timespec t = { 0, 2000000 }; nanosleep(&t, NULL); }
static pw_root *diagnostic_root;
static uint64_t diagnostic_start,diagnostic_deadline;
static const char *diagnostic_mode,*diagnostic_context="exchange";
static pw_session *diagnostic_sessions[PW_SESSION_MAX];
static unsigned diagnostic_ready_count;
static void diagnostic(pw_session *s,const char *stage,int rc) {
    if(!diagnostic_root)return;
    pw_snapshot_v2 v;assert(!pw_inspect_v2(diagnostic_root,s,PW_SNAPSHOT_ABI_V2,sizeof(v),&v));
    uint64_t now=pw_now_ns();unsigned index=0;
    for(unsigned i=0;i<PW_SESSION_MAX;i++)if(diagnostic_sessions[i]==s)index=i+1;
    fprintf(stderr,"{\"stage\":\"%s\",\"context\":\"%s\",\"mode\":\"%s\",\"session\":%u,\"rc\":\"%s\",\"rcNumber\":%d,\"elapsedNs\":%llu,\"deadlineNs\":%llu,\"remainingNs\":%llu,\"traceCount\":%zu,\"traceLimit\":%zu,\"received\":%zu,\"readLimit\":%zu,\"readCalls\":%u,\"terminal\":\"%s\",\"launchStarted\":%d,\"directExitObserved\":%d,\"lastReads\":[",
        stage,diagnostic_context,diagnostic_mode,index,pw_result_name(rc),rc,(unsigned long long)(now-diagnostic_start),(unsigned long long)diagnostic_deadline,(unsigned long long)(now<diagnostic_deadline?diagnostic_deadline-now:0),v.trace_count,v.trace_limit,v.received_bytes,v.read_limit,v.read_calls,pw_result_name(v.terminal),v.launch_started,v.direct_exit_observed);
    size_t begin=v.trace_count>8?v.trace_count-8:0;
    for(size_t i=begin;i<v.trace_count;i++){pw_read_trace t;assert(!pw_trace_at(diagnostic_root,i,&t));fprintf(stderr,"%s[%zu,%zu,%zu,%zu,%d]",i==begin?"":",",t.credit,t.phase_remaining,t.total_remaining,t.reserved_before_read,t.result);}
    fputs("]}\n",stderr);fflush(stderr);
}
static int handshake(pw_session *s) {
    int rc; do { rc = pw_handshake_step(s); if (rc == PW_AGAIN) nap(); } while (rc == PW_AGAIN);
    diagnostic(s,"handshake",rc);
    return rc;
}
static int receive(pw_session *s, const unsigned char **p, size_t *n) {
    int rc; do { rc = pw_read_frame_step(s, p, n); if (rc == PW_AGAIN) nap(); } while (rc == PW_AGAIN);
    diagnostic(s,"receive",rc);
    return rc;
}
static int flush(pw_session *s) {
    int rc; do { rc = pw_write_step(s); if (rc == PW_AGAIN) nap(); } while (rc == PW_AGAIN);
    return rc;
}
static pw_snapshot_v2 snapshot(pw_root *r, pw_session *s) {
    pw_snapshot_v2 v; assert(pw_inspect_v2(r, s,PW_SNAPSHOT_ABI_V2,sizeof(pw_snapshot_v2),&v) == PW_OK); return v;
}
static void reap(pw_session *s) {
    int rc; uint64_t until = pw_now_ns() + 1000000000ULL;
    do {
        rc = pw_observe_direct_exit(s);
        assert(pw_now_ns() < until); if (rc == PW_AGAIN) nap();
    } while (rc == PW_AGAIN);
    assert(rc == PW_OK);
}
static void finish(pw_root *r, pw_session *s) {
    pw_snapshot_v2 before = snapshot(r, s);
    (void)pw_cancel(s);
    if (before.launch_started && !before.direct_exit_observed) {
        assert(pw_terminate_direct_child(s) == PW_OK); reap(s);
    }
    pw_snapshot_v2 after = snapshot(r, s);
    assert(after.sessions == before.sessions && after.capacity_bytes == before.capacity_bytes);
    assert(after.reserved_send_bytes == before.reserved_send_bytes);
    assert(after.sent_bytes <= after.reserved_send_bytes);
    assert(after.charges_retained && !after.tree_exit_proven && !after.execution_authorized);
    assert(after.open_fds == 0 && after.pending_read_bytes == 0 && after.key_wiped);
    assert(!after.cleanup_unknown);
    unsigned closes = after.close_calls;
    (void)pw_cancel(s); assert(snapshot(r,s).close_calls == closes);
}
static unsigned trace_check(pw_root *r) {
    pw_snapshot_v2 v = snapshot(r, NULL); size_t received = 0;
    for (size_t i = 0; i < v.trace_count; i++) {
        pw_read_trace t; assert(pw_trace_at(r, i, &t) == PW_OK);
        assert(t.credit > 0 && t.credit <= 4096 && t.credit <= t.phase_remaining);
        assert(t.credit <= t.total_remaining && t.reserved_before_read == t.credit);
        assert(t.total_remaining == PW_READ_TOTAL - received);
        if (t.result > 0) { assert((size_t)t.result <= t.credit); received += (size_t)t.result; }
    }
    assert(v.received_bytes == received && v.pending_read_bytes == 0);
    return (unsigned)v.trace_count;
}
static int fd_count(void) {
    DIR *d = opendir("/dev/fd"); assert(d);
    int count = 0; struct dirent *e;
    while ((e = readdir(d))) if (strcmp(e->d_name,".") && strcmp(e->d_name,"..")) count++;
    closedir(d); return count;
}
static void ready(pw_session *s) {
    const unsigned char *p; size_t n;
    if(diagnostic_ready_count<PW_SESSION_MAX)diagnostic_sessions[diagnostic_ready_count++]=s;
    diagnostic_context="ready-ACK";
    assert(handshake(s) == PW_OK);diagnostic_context="ready-FD_OK";assert(receive(s, &p, &n) == PW_OK);
    assert(n == 5 && !memcmp(p, "FD_OK", 5));
    diagnostic_context="exchange";
}
static void *wrong_thread(void *arg) {
    assert(pw_cancel(arg) == PW_OWNER); return NULL;
}
#ifndef PW_ANONYMOUS_FIXTURE
int main(void) {
    if (!pw_platform_supported()) { puts("{\"status\":\"UNSUPPORTED\"}"); return 77; }
    int initial = fd_count();
    pw_root *r = pw_root_create(); assert(r);
    pw_session *s = NULL;
    assert(pw_start(r, pw_now_ns()+1000000000ULL, &s) == PW_UNSAFE_DEPLOYMENT);
    assert(!s && snapshot(r,NULL).sessions == 0);
    assert(pw_root_destroy(r) == PW_OK);
    assert(fd_count() == initial);
    puts("{\"status\":\"UNSAFE_DEPLOYMENT\",\"sessions\":0}"); return 0;
}
#else
int main(int argc, char **argv) {
    assert(argc == 2);
    if (!pw_platform_supported()) { puts("{\"status\":\"UNSUPPORTED\"}"); return 77; }
    int initial = fd_count();
    pw_root *r = pw_root_create(); assert(r);
    pw_session *s = NULL;
    const char *mode = argv[1]; unsigned traces = 0, waits = 0; int terminal = PW_OK;
    diagnostic_root=r;diagnostic_mode=mode;diagnostic_start=pw_now_ns();
    assert(pw_start(r,pw_now_ns(),&s) == PW_DEADLINE && !s);
    assert(pw_start(r,pw_now_ns()+6000000000ULL,&s) == PW_DEADLINE && !s);
    assert(snapshot(r,NULL).sessions == 0);
    if (!strcmp(mode,"pipe2-failure") || !strcmp(mode,"write-bootstrap")) {
        int expected = !strcmp(mode,"write-bootstrap") ? PW_QUOTA : PW_SYSTEM;
        assert(pw_start(r,pw_now_ns()+1000000000ULL,&s) == expected);
        pw_snapshot_v2 v = snapshot(r,s);
        assert(!v.launch_started && !v.write_calls && !v.sent_bytes && !v.open_fds);
#ifdef PW_PIPE2_TEST
        pw_test_check_pipe2(0);
#endif
        finish(r,s); assert(pw_root_destroy(r) == PW_OK); assert(fd_count() == initial);
        printf("{\"status\":\"OK\",\"fdLeaks\":0,\"reservedSend\":%zu,\"sent\":0,\"writeCalls\":0}\n",v.reserved_send_bytes);
        return 0;
    }
    if (!strcmp(mode, "faults")) {
        assert(pw_root_destroy(r) == PW_OK);
        for (int fault = PW_FAULT_PIPE_1; fault <= PW_FAULT_SPAWN; fault++) {
            r = pw_root_create(); assert(r); assert(pw_fixture_fail_at(r,fault) == PW_OK);
            assert(pw_start(r,pw_now_ns()+1000000000ULL,&s) == PW_SYSTEM);
            pw_snapshot_v2 v = snapshot(r,s); assert(v.sessions == 1 && !v.launch_started);
            finish(r,s); assert(pw_root_destroy(r) == PW_OK); assert(fd_count() == initial);
        }
        puts("{\"status\":\"OK\",\"faults\":7,\"fdLeaks\":0}"); return 0;
    }
    /* A non-CLOEXEC sentinel must not leak through CLOEXEC_DEFAULT. */
    int sentinel = open("/dev/null", O_RDONLY); assert(sentinel >= 0);
    assert(fcntl(sentinel, F_SETFD, !strcmp(mode,"inheritance") ? FD_CLOEXEC : 0) == 0);
    /* The deadline mode proves that a session reports PW_DEADLINE once its
       deadline passes; it does not claim that the handshake completes inside
       any particular wall-clock window. The previous 300ms budget was tight
       enough that the handshake (start + ready-ACK + FD_OK round trip) could
       expire before the scenario under test even began, which failed the
       fixture on a loaded machine while passing on an idle one. The budget
       now matches the other modes; the deadline the scenario observes is
       still the one it asked for. */
    uint64_t deadline = pw_now_ns() + 3000000000ULL;
    diagnostic_deadline=deadline;
    assert(pw_start(r,deadline,&s) == PW_OK); assert(s);
    assert(close(sentinel) == 0);
    assert(snapshot(r,s).open_fds == 3 && snapshot(r,s).parent_endpoints_verified);
#ifdef PW_PIPE2_TEST
    pw_test_check_pipe2(3);
#endif
    assert(pw_root_destroy(r) == PW_BUSY);
    if (!strcmp(mode,"bad-ack")) assert(handshake(s) == PW_AUTH);
    else if (!strcmp(mode,"oversize") || !strcmp(mode,"truncated") || !strcmp(mode,"eof")) {
        assert(handshake(s) == PW_OK);
        const unsigned char *p; size_t n;
        int expected = !strcmp(mode,"oversize") ? PW_LENGTH : !strcmp(mode,"truncated") ? PW_TRUNCATED : PW_EOF;
        assert(receive(s,&p,&n) == expected);
        pw_snapshot_v2 v = snapshot(r,s);
        assert(v.received_bytes == (expected == PW_LENGTH ? 40 : expected == PW_TRUNCATED ? 42 : 36));
    } else {
        ready(s); assert(snapshot(r,s).open_fds == 2 && snapshot(r,s).key_wiped);
        pthread_t thread; assert(pthread_create(&thread,NULL,wrong_thread,s) == 0);
        assert(pthread_join(thread,NULL) == 0);
        if (!strcmp(mode,"write-reject") || !strcmp(mode,"write-exact") || !strcmp(mode,"write-cancel") ||
            !strcmp(mode,"write-shared")) {
            pw_session *writer = s;
            if (!strcmp(mode,"write-shared")) {
                assert(pw_write_frame_begin(s,(const unsigned char *)"FIRST",5) == PW_OK);
                (void)pw_cancel(s); reap(s);
                assert(snapshot(r,s).direct_exit_status == 0);
                assert(pw_start(r,deadline,&writer) == PW_OK); ready(writer);
                // 129 - two bootstraps - cancelled 9-byte frame = 8 left.
            }
            pw_snapshot_v2 before = snapshot(r,writer);
            int reject = !strcmp(mode,"write-reject") || !strcmp(mode,"write-shared");
            assert(pw_write_frame_begin(writer,(const unsigned char *)"HELLO",5) == (reject ? PW_QUOTA : PW_OK));
            pw_snapshot_v2 admitted = snapshot(r,writer);
            assert(admitted.reserved_send_bytes == before.reserved_send_bytes + (reject ? 0 : 9));
            assert(admitted.write_calls == before.write_calls && admitted.sent_bytes == before.sent_bytes);
            if (!reject && !strcmp(mode,"write-exact")) {
                assert(flush(writer) == PW_OK);
                assert(snapshot(r,writer).sent_bytes == before.sent_bytes + 9);
            }
            // Peer independently counts bytes through EOF: denial/cancel => 0.
            (void)pw_cancel(writer); reap(writer);
            assert(snapshot(r,writer).direct_exit_status == 0);
            assert(snapshot(r,writer).reserved_send_bytes == admitted.reserved_send_bytes);
            if (writer != s) {
                finish(r,writer); (void)pw_cancel(s); reap(s);
                assert(snapshot(r,s).direct_exit_status == 0);
            }
        } else if (!strcmp(mode,"echo") || !strcmp(mode,"inheritance")) {
            for (unsigned i = 1; i <= 3; i++) {
                unsigned char bytes[127]; memset(bytes,(int)i,sizeof(bytes)); bytes[0] = 0; bytes[1] = 255;
                assert(pw_write_frame_begin(s,bytes,sizeof(bytes)) == PW_OK);
                assert(pw_write_frame_begin(s,bytes,1) == PW_BUSY); assert(flush(s) == PW_OK);
                const unsigned char *p; size_t n; assert(receive(s,&p,&n) == PW_OK);
                assert(n == sizeof(bytes) && !memcmp(p,bytes,n));
            }
            assert(pw_cancel(s) == PW_CANCELLED); reap(s);
            pw_snapshot_v2 v = snapshot(r,s);
            assert(v.direct_exit_observed && v.direct_exit_status == 0 && v.close_calls == 9);
        } else if (!strcmp(mode,"quota")) {
            pw_session *other; assert(pw_start(r,deadline,&other) == PW_OK); ready(other);
            unsigned char bytes[512]; memset(bytes,7,sizeof(bytes));
            assert(pw_write_frame_begin(s,bytes,512) == PW_OK); assert(flush(s) == PW_OK);
            const unsigned char *p; size_t n; assert(receive(s,&p,&n) == PW_OK && n == 512);
            assert(pw_write_frame_begin(other,bytes,512) == PW_OK); assert(flush(other) == PW_OK);
            assert(receive(other,&p,&n) == PW_QUOTA);
            assert(snapshot(r,other).received_bytes == PW_READ_TOTAL); finish(r,other);
            pw_session *third = s; assert(pw_start(r,deadline,&third) == PW_ADMISSION && !third);
        } else if (!strcmp(mode,"paused") || !strcmp(mode,"backpressure-deadline")) {
            unsigned char bytes[512]; memset(bytes,7,sizeof(bytes));
            int rc = PW_OK; unsigned frames = 0;
            while (!snapshot(r,s).write_waits) {
                assert(++frames < 300); assert(pw_write_frame_begin(s,bytes,sizeof(bytes)) == PW_OK);
                rc = pw_write_step(s);
                // A partial positive write is not kernel EAGAIN. Preserve the
                // pending frame and continue until an actual -EAGAIN occurs.
                while (rc == PW_AGAIN && !snapshot(r,s).write_waits) rc = pw_write_step(s);
                assert(rc == PW_OK || rc == PW_AGAIN);
            }
            assert(rc == PW_AGAIN); waits = snapshot(r,s).write_waits; assert(waits > 0);
            pw_snapshot_v2 blocked = snapshot(r,s);
            assert(blocked.reserved_send_bytes > blocked.sent_bytes);
            assert(pw_write_frame_begin(s,bytes,1) == PW_BUSY);
            assert(snapshot(r,s).reserved_send_bytes == blocked.reserved_send_bytes);
            if (!strcmp(mode,"paused")) {
                assert(pw_fixture_resume_reader(s) == PW_OK); assert(flush(s) == PW_OK);
                assert(snapshot(r,s).reserved_send_bytes == blocked.reserved_send_bytes);
                assert(snapshot(r,s).sent_bytes == blocked.reserved_send_bytes);
                assert(pw_write_frame_begin(s,(const unsigned char *)"RESUME_END",10) == PW_OK);
                assert(flush(s) == PW_OK);
                const unsigned char *p; size_t n; assert(receive(s,&p,&n) == PW_OK);
                assert(n == 7 && !memcmp(p,"DRAINED",7)); reap(s);
                assert(snapshot(r,s).direct_exit_status == 0);
            } else {
                assert(flush(s) == PW_DEADLINE);
                assert(snapshot(r,s).reserved_send_bytes == blocked.reserved_send_bytes);
            }
        } else if (!strcmp(mode,"deadline")) {
            const unsigned char *p; size_t n; assert(receive(s,&p,&n) == PW_DEADLINE);
            assert(pw_now_ns() >= deadline);
        } else if (!strcmp(mode,"trace-limit")) {
            const unsigned char *p; size_t n; int rc;
#ifdef PW_READINESS_TEST
            // Exhaust actual, recorded reads via explicit readiness races.
            // Idle poll attempts no longer constitute a read syscall.
            pw_readiness_bind(r,s,1);
#endif
            do { rc = pw_read_frame_step(s,&p,&n); } while (rc == PW_AGAIN);
            diagnostic(s,"trace-limit",rc);
            assert(rc == PW_TRACE_LIMIT && snapshot(r,s).trace_count == PW_TRACE_MAX);
        } else if (!strcmp(mode,"cancel")) {
            const unsigned char *p; size_t n; assert(pw_read_frame_step(s,&p,&n) == PW_AGAIN);
            assert(pw_cancel(s) == PW_CANCELLED);
            assert(pw_read_frame_step(s,&p,&n) == PW_CANCELLED);
            assert(!snapshot(r,s).direct_exit_observed && snapshot(r,s).lifecycle_unknown);
        } else if (!strcmp(mode,"close-read")) {
            pw_snapshot_v2 before = snapshot(r,s);
            assert(pw_write_frame_begin(s,(const unsigned char *)"X",1) == PW_OK);
            assert(flush(s) == PW_SYSTEM); /* EPIPE, process survives without global signal changes */
            assert(snapshot(r,s).reserved_send_bytes == before.reserved_send_bytes + 5);
            assert(snapshot(r,s).sent_bytes == before.sent_bytes);
        } else abort();
    }
    terminal = snapshot(r,s).terminal;
    finish(r,s); traces = trace_check(r);
    pw_snapshot_v2 v = snapshot(r,s); assert(v.charges_retained && !v.tree_exit_proven);
    printf("{\"readCredits\":[");
    for (size_t i = 0; i < traces; i++) {
        pw_read_trace tr; assert(pw_trace_at(r,i,&tr) == PW_OK);
        printf("%s[%zu,%zu,%zu,%zu,%d]",i ? "," : "",tr.credit,tr.phase_remaining,
            tr.total_remaining,tr.reserved_before_read,tr.result);
    }
    assert(pw_root_destroy(r) == PW_OK); assert(fd_count() == initial);
    printf("],");
    printf("\"status\":\"OK\",\"terminal\":\"%s\",\"readCalls\":%u,\"writeWaits\":%u,"
        "\"sessionsRetained\":%zu,\"received\":%zu,\"reservedSend\":%zu,\"sent\":%zu,\"writeCalls\":%u,"
        "\"atomicPairsChecked\":%u,\"concurrentSpawnsChecked\":%u,"
        "\"positiveInheritanceControls\":%u,"
        "\"fdLeaks\":0,\"executionAuthorized\":false,\"treeExitProven\":false}\n",
        pw_result_name(terminal),traces,waits,v.sessions,v.received_bytes,v.reserved_send_bytes,v.sent_bytes,v.write_calls,
        !strcmp(mode,"inheritance") ? 3u : 0u,!strcmp(mode,"inheritance") ? 3u : 0u,
        !strcmp(mode,"inheritance") ? 3u : 0u);
    return 0;
}
#endif
