#include "anonymous.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
static uint64_t deadline;
static uint64_t now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return (uint64_t)t.tv_sec*1000000000ULL+t.tv_nsec; }
static int transfer(int fd,unsigned char *p,size_t n,int writing) {
    size_t used=0;
    while(used<n && now()<deadline) {
        size_t grant=n-used; if(grant>4096) grant=4096;
        ssize_t done=writing ? write(fd,p+used,grant) : read(fd,p+used,grant);
        if(done>0) used+=(size_t)done;
        else if(done<0 && (errno==EAGAIN || errno==EINTR)) { struct timespec t={0,100000}; nanosleep(&t,NULL); }
        else return 0;
    }
    return used==n;
}
static int header(size_t n) {
    unsigned char h[4]={(unsigned char)(n>>24),(unsigned char)(n>>16),(unsigned char)(n>>8),(unsigned char)n};
    return transfer(4,h,4,1);
}
int pw_capacity_peer_run(uint64_t until) {
    deadline=until;
    unsigned char *bytes=malloc(PW_V2_BODY_MAX); if(!bytes) return 40;
    int result=0;
    for(;;) {
        unsigned char h[4]; if(!transfer(3,h,4,0)) break;
        size_t n=((size_t)h[0]<<24)|((size_t)h[1]<<16)|((size_t)h[2]<<8)|h[3];
        if(!n || n>PW_V2_BODY_MAX || !transfer(3,bytes,n,0)) {result=41;break;}
        if(bytes[0]==3) { header(PW_V2_BODY_MAX+1); break; }
        if(bytes[0]==4) { n=PW_V2_BODY_MAX; memset(bytes,4,n); }
        if(bytes[0]==6) n=1; // large sink request, bounded one-byte acknowledgement
        if(bytes[0]==5) {
            for(unsigned i=0;i<PW_FRAME_COUNT_MAX+1;i++) if(!header(1)||!transfer(4,bytes,1,1)) break;
            break;
        }
        if(!header(n)||!transfer(4,bytes,n,1)) break;
    }
    free(bytes); return result;
}
