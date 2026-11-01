#ifndef PW_ANONYMOUS_FIXTURE_ONLY_H
#define PW_ANONYMOUS_FIXTURE_ONLY_H
#ifndef PW_ANONYMOUS_FIXTURE
#error "Fixture controls must never be compiled into a production capability"
#endif
#include "anonymous.h"
/* Compile-time test seam, not a runtime launcher configuration interface. */
enum { PW_FAULT_NONE, PW_FAULT_PIPE_1, PW_FAULT_PIPE_2, PW_FAULT_PIPE_3,
       PW_FAULT_FLAGS, PW_FAULT_ACTIONS, PW_FAULT_SPAWN };
int pw_fixture_fail_at(pw_root *, int);
int pw_fixture_resume_reader(pw_session *);
#endif
