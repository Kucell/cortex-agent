/* Deliberately compiled WITHOUT the new header. Recreates the old three-arg
 * caller using a smaller layout. It must fail to link to the new core. */
struct old_snapshot { unsigned long sessions,capacity_bytes,received_bytes,sent_bytes; };
extern int pw_inspect(void *,void *,struct old_snapshot *);
int main(void) { struct old_snapshot value;return pw_inspect(0,0,&value); }
