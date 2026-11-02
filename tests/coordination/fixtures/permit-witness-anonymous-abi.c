#include "anonymous.h"
#include <assert.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static pw_root *root;
static void unchanged(const unsigned char *p,size_t n) {
    for(size_t i=0;i<n;i++) assert(p[i]==0xa5);
}
static void *wrong_owner(void *data) {
    pw_snapshot_v2 *snapshot=data;
    assert(pw_inspect_v2(root,NULL,PW_SNAPSHOT_ABI_V2,sizeof(*snapshot),snapshot)==PW_OWNER);
    unchanged((const unsigned char *)snapshot,sizeof(*snapshot));return NULL;
}
int main(int argc,char **argv) {
    assert(argc==2 && pw_platform_supported());
    void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);assert(library);
    assert(dlsym(library,"pw_inspect")==NULL);
    assert(dlsym(library,"pw_inspect_v2")!=NULL);
    root=pw_root_create_profile(PW_PROFILE_V2);assert(root);
    // Exact allocations let ASan detect ANY write past the caller's buffer,
    // while sentinels also detect writes that remain within that allocation.
    const size_t sizes[]={0,1,8,64,sizeof(pw_snapshot_v2)-1,sizeof(pw_snapshot_v2)+1,SIZE_MAX};
    unsigned refused=0;
    for(size_t i=0;i<sizeof(sizes)/sizeof(sizes[0]);i++) {
        size_t actual=sizes[i]==SIZE_MAX?1:sizes[i]?sizes[i]:1;
        unsigned char *bytes=malloc(actual);assert(bytes);memset(bytes,0xa5,actual);
        assert(pw_inspect_v2(root,NULL,PW_SNAPSHOT_ABI_V2,sizes[i],(pw_snapshot_v2 *)bytes)==PW_ABI);
        unchanged(bytes,actual);free(bytes);refused++;
    }
    pw_snapshot_v2 v;memset(&v,0xa5,sizeof(v));
    for(uint32_t version=0;version<5;version++) if(version!=PW_SNAPSHOT_ABI_V2) {
        assert(pw_inspect_v2(root,NULL,version,sizeof(v),&v)==PW_ABI);
        unchanged((const unsigned char *)&v,sizeof(v));refused++;
    }
    assert(pw_inspect_v2(root,NULL,PW_SNAPSHOT_ABI_V2,sizeof(v),NULL)==PW_ABI);
    pthread_t thread;assert(pthread_create(&thread,NULL,wrong_owner,&v)==0);assert(pthread_join(thread,NULL)==0);
    assert(pw_inspect_v2(NULL,NULL,PW_SNAPSHOT_ABI_V2,sizeof(v),&v)==PW_OWNER);
    unchanged((const unsigned char *)&v,sizeof(v));
    struct { unsigned char before[32];pw_snapshot_v2 value;unsigned char after[32]; } guarded;
    memset(&guarded,0xa5,sizeof(guarded));
    assert(pw_inspect_v2(root,NULL,PW_SNAPSHOT_ABI_V2,sizeof(guarded.value),&guarded.value)==PW_OK);
    unchanged(guarded.before,sizeof(guarded.before));unchanged(guarded.after,sizeof(guarded.after));
    v=guarded.value;
    assert(v.abi_version==2 && v.struct_bytes==sizeof(v) && !v.sessions && !v.capacity_bytes);
    assert(v.root_capacity_bytes==v.root_metadata_bytes+v.trace_capacity_bytes);
    assert(v.trace_capacity_bytes==PW_V2_TRACE_MAX*sizeof(pw_read_trace));
    assert(v.max_frame_bytes==PW_V2_BODY_MAX && !v.tree_exit_proven && v.charges_retained);
    assert(pw_root_destroy(root)==PW_OK);
    assert(dlclose(library)==0);
    printf("{\"status\":\"OK\",\"abiVersion\":2,\"structBytes\":%zu,\"mismatchesWithoutWrites\":%u,"
        "\"rootMetadataReservedBytes\":%zu,\"traceCapacityReservedBytes\":%zu,\"oldSymbolAbsent\":true}\n",
        sizeof(v),refused,v.root_metadata_bytes,v.trace_capacity_bytes);
    return 0;
}
