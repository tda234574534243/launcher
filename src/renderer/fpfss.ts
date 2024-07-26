import { FpfssUser } from '@shared/back/types';
import axios from 'axios';
import * as remote from '@electron/remote';
import { uuid } from '@shared/utils/uuid';
import { DialogState } from 'flashpoint-launcher';
import EventEmitter = require('events');
import * as mainActions from '@renderer/store/main/slice';
import { dialogResEvent } from '@renderer/store/main/dialog';

export async function fpfssLogin(createDialog: typeof mainActions.createDialog, cancelDialog: typeof mainActions.cancelDialog): Promise<FpfssUser | null> {
  const fpfssBaseUrl = window.Shared.preferences.data.fpfssBaseUrl;
  // Get device auth token from FPFSS
  const tokenUrl = `${fpfssBaseUrl}/auth/device`;
  const data = {
    'client_id': 'flashpoint-launcher',
    'scope': 'identity game:read game:edit submission:read submission:read-files',
  };
  const formData = new URLSearchParams(data).toString();
  const res = await axios.post(tokenUrl, formData, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    }
  });
  const token = {
    'device_code': res.data['device_code'],
    'user_code': res.data['user_code'],
    'verification_uri': res.data['verification_uri'],
    'verification_uri_complete': res.data['verification_uri_complete'],
    'expires_in': res.data['verification_uri'],
    'interval': res.data['interval']
  };

  const pollUrl = `${fpfssBaseUrl}/auth/token`;
  const profileUrl = `${fpfssBaseUrl}/api/profile`;
  await remote.shell.openExternal(token.verification_uri_complete);

  const dialog: DialogState = {
    largeMessage: true,
    message: 'Please login in your browser to continue',
    buttons: ['Cancel'],
    id: uuid()
  };

  createDialog(dialog);

  // Start loop until an end state occurs
  return new Promise<FpfssUser | null>((resolve, reject) => {
    const pollData = {
      'device_code': token.device_code,
      'client_id': 'flashpoint-launcher',
      'grant_type': 'urn:ietf:params:oauth:grant-type:device_code'
    };
    const formData = new URLSearchParams(pollData).toString();
    const interval = setInterval(async () => {
      // Poll server for flow state
      await axios.post(pollUrl, formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      })
      .then(async (res) => {
        if (res.data['access_token']) {
          // Found token, fetch profile info
          return axios.get(profileUrl, { headers: {
            'Authorization': `Bearer ${res.data['access_token']}`
          } })
          .then((profileRes) => {
            const user: FpfssUser = {
              username: profileRes.data['Username'],
              userId: profileRes.data['UserID'],
              avatarUrl: profileRes.data['AvatarURL'],
              roles: profileRes.data['Roles'],
              accessToken: res.data['access_token']
            };
            clearInterval(interval);
            resolve(user);
          })
          .catch((err) => {
            clearInterval(interval);
            reject('Failed to fetch profile info - ' + err);
            return;
          });
        }
        if (res.data['error']) {
          switch (res.data['error']) {
            case 'authorization_pending':
              // Keep polling
              break;
            case 'access_denied':
              clearInterval(interval);
              resolve(null);
              break;
            case 'expired_token':
              clearInterval(interval);
              resolve(null);
              break;
          }
        }
      })
      .catch((err) => {
        console.log(err);
        clearInterval(interval);
        reject('Failed to contact FPFSS while polling');
      });
    }, token.interval * 1000);
    // Listen for dialog response
    dialogResEvent.once(dialog.id, (d: DialogState, res: number) => {
      clearInterval(interval);
      reject('User Cancelled');
    });
  })
  .finally(() => {
    cancelDialog(dialog.id);
  });
}
