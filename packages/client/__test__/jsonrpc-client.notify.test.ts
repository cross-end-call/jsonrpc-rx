import { describe, it } from 'vitest';
import { Deferred, JsonrpcErrorMessage } from '@jsonrpc-rx/core';
import { getJsonrpcInstance } from './util/get-jsonrpc-instance';

describe('notify', () => {
  it('notify normal', async ({ expect }) => {
    const { jsonrpcClient, jsonrpcServer } = getJsonrpcInstance({ delay: 100 });
    const { promise, resolve } = new Deferred<string>();

    jsonrpcServer.onNotify<[string]>('hello', ([p]) => resolve(p));
    jsonrpcClient.notify('hello', ['hahaha']);

    const result = await promise;
    expect(result).toEqual('hahaha');
  });

  it('notify invalid params', async ({ expect }) => {
    const { jsonrpcClient } = getJsonrpcInstance({ delay: 100 });
    try {
      await jsonrpcClient.notify('errorMethod', 'errorParams' as any);
    } catch (error) {
      expect(error.toString()).includes(JsonrpcErrorMessage.InvalidParams);
      expect(error.toString()).includes('the parameters invalid');
    }
  });
});
