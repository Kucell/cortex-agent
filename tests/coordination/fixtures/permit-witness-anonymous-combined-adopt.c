#include "combined-session.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static const char *mode;
static volatile sig_atomic_t released;
static int eof_probe;
static uint64_t fake_now;
static unsigned expire_after_read;
static int bootstrap_received;
static void signal_release(int sig){(void)sig;released=1;}
static void nap(void){struct timespec t={0,1000000};nanosleep(&t,NULL);}
int pw_adopt_clock_gettime(clockid_t clock,struct timespec *out){
    int rc=clock_gettime(clock,out);
    if(!rc&&expire_after_read&&!--expire_after_read){out->tv_sec+=6;fake_now=(uint64_t)out->tv_sec*1000000000ULL+out->tv_nsec;}
    else if(!rc&&fake_now){out->tv_sec=(time_t)(fake_now/1000000000ULL);out->tv_nsec=(long)(fake_now%1000000000ULL);}
    return rc;
}
int pw_adopt_fcntl(int fd,int command,...);
#include <stdarg.h>
int pw_adopt_fcntl(int fd,int command,...){
    int arg=0;if(command==F_SETFD||command==F_SETNOSIGPIPE){va_list ap;va_start(ap,command);arg=va_arg(ap,int);va_end(ap);}
    if(command==F_SETFD&&mode&&mode[0]=='s'&&mode[1]=='e'&&mode[2]=='t'&&fd==mode[4]-'0'){errno=EIO;return -1;}
    return command==F_SETFD||command==F_SETNOSIGPIPE?fcntl(fd,command,arg):fcntl(fd,command);
}
ssize_t pw_adopt_read(int fd,void *p,size_t n){
    if(fd==5&&n==1){eof_probe++;if(!strcmp(mode,"system")){errno=EIO;return -1;}if(!strcmp(mode,"trace")){errno=EAGAIN;return -1;}}
    ssize_t rc=read(fd,p,n);
    if(fd==5&&rc==56)bootstrap_received=1;
    if(fd==5&&rc==56&&!strcmp(mode,"deadline"))expire_after_read=2;
    return rc;
}
int pw_adopt_poll(struct pollfd *fds,nfds_t count,int timeout){
    assert(count==1&&timeout==0);
    // Explicit readiness/read race after the real bootstrap was consumed.
    // No fake readiness during bootstrap acquisition or in other modes.
    if(fds[0].fd==5&&bootstrap_received&&(!strcmp(mode,"trace")||!strcmp(mode,"system"))){fds[0].revents=POLLIN;return 1;}
    return poll(fds,count,timeout);
}
static int fd_count(void){int count=0;for(int i=0;i<64;i++)if(fcntl(i,F_GETFD)>=0)count++;return count;}
static void child(const char *m){
    mode=m;struct sigaction sa={0};sa.sa_handler=signal_release;sigemptyset(&sa.sa_mask);assert(!sigaction(SIGUSR1,&sa,NULL));
    int sentinel=open("/dev/null",O_RDONLY|O_CLOEXEC);assert(sentinel>=6);
    int initial=fd_count(),foreign=!strncmp(m,"foreign-",8),fd=foreign?m[8]-'0':0;
    if(foreign){assert(!close(fd));assert(open("/dev/null",fd==4?O_WRONLY:O_RDONLY)==fd);}
    if(!strncmp(m,"flag-",5)){int target=m[5]-'0';assert(!fcntl(target,F_SETFL,fcntl(target,F_GETFL)&~O_NONBLOCK));}
    pw_root *r=pw_root_create_profile(PW_PROFILE_STATE_V2);assert(r);pw_session *s=(void *)1;
    int rc=pw_state_adopt_fixture_v1(r,&s);
    if(foreign){
        assert(rc==PW_SYSTEM&&!s);assert(fd_count()==initial);
        for(int i=3;i<=5;i++)assert(fcntl(i,F_GETFD)>=0);
        pw_snapshot_v2 v;assert(!pw_inspect_v2(r,NULL,2,sizeof(v),&v));assert(v.sessions==0&&!v.capacity_bytes);
        assert(!pw_root_destroy(r));for(int i=3;i<=5;i++)assert(!close(i));
    }else{
        int expected=PW_SYSTEM;
        if(!strncmp(m,"set-",4)||!strncmp(m,"flag-",5))assert(rc==expected);
        else{
            assert(!rc);pw_ss_root *sr=pw_ss_root_create_v1();assert(sr);pw_ss_session *state=NULL;
            do{rc=pw_state_accept_step_fixture_v1(s,sr,&state);if(rc==PW_AGAIN&&strcmp(m,"trace"))nap();}while(rc==PW_AGAIN);
            if(!strcmp(m,"quota"))expected=PW_QUOTA;
            else if(!strcmp(m,"trace"))expected=PW_TRACE_LIMIT;
            else if(!strcmp(m,"deadline"))expected=PW_DEADLINE;
            else if(!strcmp(m,"extra"))expected=PW_LENGTH;
            assert(rc==expected&&!state);assert(!pw_ss_root_destroy_v1(sr));
        }
        pw_snapshot_v2 v;assert(!pw_inspect_v2(r,s,2,sizeof(v),&v));
        assert(v.terminal==expected&&v.open_fds==0&&v.close_calls==3&&v.key_wiped&&!v.cleanup_unknown);
        assert(fd_count()==initial-3);for(int i=3;i<=5;i++){errno=0;assert(fcntl(i,F_GETFD)<0&&errno==EBADF);}
        pw_ss_root *sr=pw_ss_root_create_v1();pw_ss_session *state=NULL;assert(pw_state_accept_step_fixture_v1(s,sr,&state)==expected);assert(!pw_ss_root_destroy_v1(sr));
        pw_snapshot_v2 again;assert(!pw_inspect_v2(r,s,2,sizeof(again),&again));
        assert(again.close_calls==3&&again.sessions==v.sessions&&again.capacity_bytes==v.capacity_bytes&&again.charges_retained&&!again.tree_exit_proven);
        assert(!pw_root_destroy(r));
        printf("{\"mode\":\"%s\",\"terminal\":\"%s\",\"closed\":3,\"fdDelta\":-3,\"eofSyscalls\":%d}\n",m,pw_result_name(expected),eof_probe);fflush(stdout);
    }
    assert(fcntl(sentinel,F_GETFD)>=0);assert(!close(sentinel));
    // Keep this process alive: the parent must see actual endpoint EOF/EPIPE
    // before release, rather than relying on process exit to close leaks.
    assert(!kill(getppid(),SIGUSR2));while(!released)nap();_exit(0);
}
int main(int argc,char **argv){
    assert(argc==2||argc==3);if(argc==3){child(argv[2]);return 0;}
    struct sigaction sa={0};sa.sa_handler=signal_release;sigemptyset(&sa.sa_mask);assert(!sigaction(SIGUSR2,&sa,NULL));
    mode=argv[1];int pipes[3][2];for(int i=0;i<3;i++)assert(!pipe2(pipes[i],O_CLOEXEC|O_NONBLOCK));
    int source[3];int original[]={pipes[0][0],pipes[1][1],pipes[2][0]};
    posix_spawn_file_actions_t actions;posix_spawnattr_t attr;assert(!posix_spawn_file_actions_init(&actions));assert(!posix_spawnattr_init(&attr));assert(!posix_spawnattr_setflags(&attr,POSIX_SPAWN_CLOEXEC_DEFAULT));
    for(int i=0;i<3;i++)assert(!posix_spawn_file_actions_adddup2(&actions,i,i));
    for(int i=0;i<3;i++){source[i]=fcntl(original[i],F_DUPFD_CLOEXEC,16);assert(source[i]>=0);assert(!posix_spawn_file_actions_adddup2(&actions,source[i],i+3));assert(!posix_spawn_file_actions_addclose(&actions,source[i]));}
    char *args[]={(char *)PW_ADOPT_BINARY,"child",argv[1],NULL},*env[]={NULL};pid_t pid;assert(!posix_spawn(&pid,PW_ADOPT_BINARY,&actions,&attr,args,env));
    posix_spawn_file_actions_destroy(&actions);posix_spawnattr_destroy(&attr);for(int i=0;i<3;i++){close(source[i]);close(original[i]);}
    assert(!fcntl(pipes[0][1],F_SETNOSIGPIPE,1));assert(!fcntl(pipes[2][1],F_SETNOSIGPIPE,1));
    if(strncmp(mode,"set-",4)&&strncmp(mode,"flag-",5)&&strncmp(mode,"foreign-",8)){
        unsigned char bootstrap[57]={0};uint64_t end=pw_now_ns()+4000000000ULL;for(int i=0;i<8;i++)bootstrap[48+i]=(unsigned char)(end>>(56-i*8));
        assert(write(pipes[2][1],bootstrap,!strcmp(mode,"extra")?57:56)==(!strcmp(mode,"extra")?57:56));
    }
    uint64_t end=pw_now_ns()+4000000000ULL;unsigned char byte;ssize_t n;int status;
    while(!released){assert(waitpid(pid,&status,WNOHANG)==0);assert(pw_now_ns()<end);nap();}
    do{n=read(pipes[1][0],&byte,1);if(n<0){assert(errno==EAGAIN);nap();}assert(pw_now_ns()<end);}while(n<0);
    assert(n==0);assert(waitpid(pid,&status,WNOHANG)==0);
    errno=0;assert(write(pipes[0][1],"x",1)<0&&errno==EPIPE);errno=0;assert(write(pipes[2][1],"x",1)<0&&errno==EPIPE);
    assert(!kill(pid,SIGUSR1));assert(waitpid(pid,&status,0)==pid&&WIFEXITED(status)&&!WEXITSTATUS(status));
    close(pipes[0][1]);close(pipes[1][0]);close(pipes[2][1]);printf("{\"status\":\"OK\",\"liveChildEOF\":true,\"mode\":\"%s\"}\n",mode);return 0;
}
