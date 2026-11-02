/* Finite deterministic negative fixture for the legacy harness diagnostic.
 * Hold only the SECOND child's FD_OK body after two actual ACK reads. This
 * is an injected race, never evidence attributing a natural historical crash. */
#include <errno.h>
#include <poll.h>
#include <unistd.h>
static unsigned acks;
int pw_ready_fault_poll(struct pollfd *fds,nfds_t count,int timeout){
    if(acks==2){fds[0].revents=POLLIN;return 1;}
    return poll(fds,count,timeout);
}
ssize_t pw_ready_fault_read(int fd,void *p,size_t n){
    if(acks==2&&n==5){errno=EAGAIN;return -1;}
    ssize_t rc=read(fd,p,n);if(n==32&&rc==32)acks++;return rc;
}
