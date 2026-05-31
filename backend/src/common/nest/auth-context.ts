export interface WebUserContext {
  userId: string;
  email: string;
  username: string;
}

export interface DeviceContext {
  deviceId: string;
  mac: string;
}

export const CURRENT_USER_KEY = 'currentUser';
export const CURRENT_DEVICE_KEY = 'currentDevice';
export const IS_PUBLIC_KEY = 'IS_PUBLIC';
