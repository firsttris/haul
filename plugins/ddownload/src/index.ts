/**
 * ddownload.com (formerly ddl.to), an XFileSharing site. Premium only in v1.
 *
 * Account: user + password for the web login, or leave the user empty and put the
 * API key into the password field.
 *
 * The flow still needs to be checked by hand against a real premium account (plan M0):
 * JD's DdownloadCom.java / XFileSharingProBasic.java and the pyLoad plugin are the reference.
 */
import { definePlugin } from '@haul/plugin-sdk';
import { createXfsPlugin } from '@haul/plugin-sdk/xfs';

export default definePlugin(
  createXfsPlugin({
    id: 'ddownload',
    name: 'ddownload',
    version: 1,
    domains: ['ddownload.com', 'ddl.to'],
    fileIdLength: 12,
    apiBase: 'https://api-v2.ddownload.com/api',
    accountRequired: true,
    maxConnections: 4,
  }),
);
