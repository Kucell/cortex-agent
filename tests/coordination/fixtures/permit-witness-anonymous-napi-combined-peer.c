/* N-API close barrier only: reuse the independently reviewed protocol peer.
 * It has completed authenticated CLOSE and destroyed its own roots before
 * staying alive here. No key, descriptor or identity API is added. */
#define main pw_cs_protocol_peer_main
#include "permit-witness-anonymous-combined-peer.c"
#undef main
int main(void) {
    int rc=pw_cs_protocol_peer_main();
    if(!strcmp(PW_CS_MODE,"close-hold")) {
        // SIGUSR1 is the native owner's explicit release, latched even if it
        // arrived just before this barrier. A deadline detects missing release.
        uint64_t end=pw_now_ns()+5000000000ULL;
        while(!resumed){assert(pw_now_ns()<end);nap();}
    }
    return rc;
}
