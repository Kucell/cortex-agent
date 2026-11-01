#define NAPI_VERSION 8
#include <node_api.h>
#include <cassert>
#ifndef PW_NAPI_COPY_FAIL
#define PW_NAPI_COPY_FAIL 0
#endif
// Test-link substitution only: first result delivery has a pending exception.
extern "C" napi_status pw_cs_napi_buffer_copy(napi_env env,size_t n,const void *p,void **copy,napi_value *value) {
    static thread_local bool injected=false;
    if(PW_NAPI_COPY_FAIL&&!injected){injected=true;assert(n==1048599);
        assert(napi_throw_error(env,"INJECTED_BUFFER_COPY","fixture delivery failure")==napi_ok);return napi_pending_exception;}
    return napi_create_buffer_copy(env,n,p,copy,value);
}
