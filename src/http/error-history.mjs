/** Explicitly requested history cleanup is not proof a past side effect succeeded. */
export function archiveReviewedErrors(store,cutoff) {
  if(!Number.isFinite(Date.parse(cutoff||'')))return 0;
  const ids=store.allErrors().filter(error=>error.createdAt<=cutoff &&
    (!error.taskId||!['running','queued','waiting'].includes(store.task(error.taskId)?.status))).map(e=>e.id);
  return store.clearErrors(ids,{reason:'user-requested-history-archive; not a delivery receipt'});
}
