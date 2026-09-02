import { describe, expect, it } from 'vitest';
import {
  buildDeviceCodeBody,
  buildDevicePollBody,
  buildRefreshBody,
  classifyDevicePollError,
  GITHUB_DEVICE_GRANT_TYPE,
} from './githubCopilotAuth';

describe('buildDeviceCodeBody', () => {
  it('encodes the client id with no scope by default', () => {
    const body = new URLSearchParams(buildDeviceCodeBody('client-123'));
    expect(body.get('client_id')).toBe('client-123');
    expect(body.get('scope')).toBeNull();
  });

  it('includes scope when given', () => {
    const body = new URLSearchParams(buildDeviceCodeBody('client-123', 'read:user'));
    expect(body.get('scope')).toBe('read:user');
  });
});

describe('buildDevicePollBody', () => {
  it('encodes the RFC 8628 device_code grant', () => {
    const body = new URLSearchParams(buildDevicePollBody('client-123', 'device-abc'));
    expect(body.get('client_id')).toBe('client-123');
    expect(body.get('device_code')).toBe('device-abc');
    expect(body.get('grant_type')).toBe(GITHUB_DEVICE_GRANT_TYPE);
  });
});

describe('buildRefreshBody', () => {
  it('encodes the refresh_token grant', () => {
    const body = new URLSearchParams(buildRefreshBody('client-123', 'refresh-xyz'));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-xyz');
  });
});

describe('classifyDevicePollError', () => {
  it('treats authorization_pending as pending', () => {
    expect(classifyDevicePollError('authorization_pending')).toBe('pending');
  });
  it('treats slow_down as slow_down', () => {
    expect(classifyDevicePollError('slow_down')).toBe('slow_down');
  });
  it.each(['expired_token', 'access_denied', 'unsupported_grant_type', 'anything_else'])(
    'treats %s as a stop condition',
    (error) => {
      expect(classifyDevicePollError(error)).toBe('stop');
    },
  );
});
