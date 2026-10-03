/** Messages picked by a runtime key (status, filter, disk …), for pickMsg(). */
import * as m from './paraglide/messages';

export const msgGroup = {
  accounts_status: {
    unchecked: m.accounts_status_unchecked,
    checking: m.accounts_status_checking,
    valid: m.accounts_status_valid,
    invalid: m.accounts_status_invalid,
    error: m.accounts_status_error,
  },
  disks: {
    tmp: m.disks_tmp,
    fertig: m.disks_fertig,
  },
  downloads_filters: {
    all: m.downloads_filters_all,
    active: m.downloads_filters_active,
    waiting: m.downloads_filters_waiting,
    finished: m.downloads_filters_finished,
    failed: m.downloads_filters_failed,
  },
} as const;
