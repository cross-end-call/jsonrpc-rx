import {
  JsonrpcErrorCode,
  JsonrpcRequestBody,
  JsonrpcResponseBody,
  SubscribleResult,
  SubscribleResultSatate,
  SubscribeHandler,
  SubscribleResultDataItem,
  SubscribleResultErrorItem,
  MessageSender,
  MessageReceiver,
  MessageBody,
  Disposable,
  Dispose,
  isJsonrpcResponseBody,
  isJsonrpcRequestBody,
  FOR_SUBSCRIBLE_SUFFIX,
  FOR_SUBSCRIBLE_CANCEL_SUFFIX,
  IDisposable,
  IJsonrpcServer,
  toType,
  invokeAsPromise,
  uuid,
  Publisher,
  ensurePublisher,
  validJsonrpcError,
  JsonrpcParams,
  JsonrpcBaseConfig,
  JsonrpcCostomError,
  PromisifyReturnEach,
  INNER_ONCALL_FOR_QUERY_MODE,
  ExposeMode,
  asyncFuncParamsInterceptor,
} from '@jsonrpc-rx/core';
import { MessageSenderCtx } from './message-sender-ctx';
import { MessageReceiverCtx } from './message-receiver-ctx';

export class JsonrpcServer implements IJsonrpcServer {
  static SUBSCRIBLE_RESULT_CACHE_MILLIS = 32;

  private callHandlerMap = new Map<string, (args: any) => any>();
  private notifyHandlerMap = new Map<string, (args: any) => void>();
  private onSubscribeSubjectSet = new Set<string>();

  private msgSenderCtx: MessageSenderCtx;
  private msgReceiverCtx: MessageReceiverCtx;

  constructor(
    private msgSender: MessageSender,
    private msgReceiver: MessageReceiver,
    private jsonrpcBaseConfig: JsonrpcBaseConfig = {},
  ) {
    // 设置内置拦截器
    const outerInterceptors = this.jsonrpcBaseConfig?.interceptors ?? [];
    this.jsonrpcBaseConfig.interceptors = [asyncFuncParamsInterceptor, ...outerInterceptors];

    // 初始化拦截器的上下文
    const interceptorNum = this.jsonrpcBaseConfig?.interceptors?.length ?? 0;
    const interceptorSafeContextArr = '.'
      .repeat(interceptorNum)
      .split('')
      .map(() => ({}));
    this.msgSenderCtx = new MessageSenderCtx(this.msgSender, interceptorSafeContextArr, this.jsonrpcBaseConfig);
    this.msgReceiverCtx = new MessageReceiverCtx(this.msgReceiver, interceptorSafeContextArr, this.jsonrpcBaseConfig);
    this.receiveMessage();
    this.onCallForQueryMode();
  }

  onCall = <Params extends JsonrpcParams>(method: string, callHandler: (params: PromisifyReturnEach<Params>) => any): IDisposable => {
    if (!(toType(method) === 'string' && (toType(callHandler) === 'function' || toType(callHandler) === 'asyncfunction'))) {
      this.throwParamsInternalError('the parameters invalid');
    }

    if (this.callHandlerMap.has(method)) this.throwParamsInternalError(`the method ${method} is repeated`);
    this.callHandlerMap.set(method, callHandler);

    return new Disposable(() => this.callHandlerMap.delete(method));
  };

  onNotify = <Params extends JsonrpcParams>(
    notifyName: string,
    notifyHandler: (params: PromisifyReturnEach<Params>) => void,
  ): IDisposable => {
    if (!(toType(notifyName) === 'string' && (toType(notifyHandler) === 'function' || toType(notifyHandler) === 'asyncfunction'))) {
      this.throwParamsInternalError('the parameters invalid');
    }

    if (this.notifyHandlerMap.has(notifyName)) this.throwParamsInternalError(`the notify ${notifyName} is repeated`);
    this.notifyHandlerMap.set(notifyName, notifyHandler);

    return new Disposable(() => this.notifyHandlerMap.delete(notifyName));
  };

  onSubscribe<Params extends JsonrpcParams, PublishValue = any>(
    subjectName: string,
    subscribeHandler: SubscribeHandler<PromisifyReturnEach<Params>, PublishValue>,
  ): IDisposable {
    if (!(toType(subjectName) === 'string' && toType(subscribeHandler) === 'function'))
      this.throwParamsInternalError('the parameters invalid');

    if (this.onSubscribeSubjectSet.has(subjectName)) this.throwParamsInternalError(`the subject ${subjectName} is repeated`);
    this.onSubscribeSubjectSet.add(subjectName);

    const onSubscribeCancelMap: Map<string | number, Dispose> = new Map();
    const subscribleResultCache = new Set<SubscribleResultDataItem>();
    const subscribleErrorCache = new Set<SubscribleResultErrorItem>();
    const subscribleCompleteCache = new Set<SubscribleResultDataItem>();
    let subscribleResultCacheTimer: any = -1;
    let subscribleErrorCacheTimer: any = -1;
    let subscribleCompleteCacheTimer: any = -1;

    const subscribleCallHandler = (params: JsonrpcParams) => {
      const subscribeId = uuid();

      const sendJsonrpcResponseBody = (result: Pick<SubscribleResult, 'state' | 'data' | 'error'>) => {
        const responseBody: JsonrpcResponseBody<SubscribleResult> = {
          jsonrpc: '2.0',
          id: subscribeId, // 这个 id 不能被采信，这里只是为了数据结构能通过验证，实际上，这个 id 也不会被采用
          result: {
            ...result,
            isSubscribleResult: true,
            subjectName,
          },
        };
        this.msgSenderCtx.send(responseBody);
      };

      const publisher: Publisher = ensurePublisher({
        next: (value) => {
          subscribleResultCache.add({ subscribeId, subscribeValue: value });
          clearTimeout(subscribleResultCacheTimer);
          subscribleResultCacheTimer = setTimeout(() => {
            sendJsonrpcResponseBody({ state: SubscribleResultSatate.Next, data: Array.from(subscribleResultCache) });
            subscribleResultCache.clear();
          }, JsonrpcServer.SUBSCRIBLE_RESULT_CACHE_MILLIS);
        },
        error: (error) => {
          subscribleErrorCache.add({ subscribeId, subscribeError: error });
          clearTimeout(subscribleErrorCacheTimer);
          subscribleErrorCacheTimer = setTimeout(() => {
            sendJsonrpcResponseBody({ state: SubscribleResultSatate.Error, error: Array.from(subscribleErrorCache) });
            subscribleErrorCache.clear();
          }, JsonrpcServer.SUBSCRIBLE_RESULT_CACHE_MILLIS);
        },
        complete: () => {
          subscribleCompleteCache.add({ subscribeId, subscribeValue: undefined });
          clearTimeout(subscribleCompleteCacheTimer);
          subscribleCompleteCacheTimer = setTimeout(() => {
            sendJsonrpcResponseBody({ state: SubscribleResultSatate.Complete, data: Array.from(subscribleCompleteCache) });
            subscribleCompleteCache.clear();
          }, JsonrpcServer.SUBSCRIBLE_RESULT_CACHE_MILLIS);
        },
      });
      const dispose: Dispose = (subscribeHandler as SubscribeHandler<JsonrpcParams>).call({}, publisher, params);
      onSubscribeCancelMap.set(subscribeId, dispose);

      return subscribeId;
    };
    const forSubscrible = subjectName + FOR_SUBSCRIBLE_SUFFIX;
    const forSubscribleDisposable = this.onCall(forSubscrible, subscribleCallHandler);

    const subscribleCancelNotifyHandler = (params: JsonrpcParams) => {
      const [subscribeId] = params as [string | number];
      const dispose = onSubscribeCancelMap.get(subscribeId);
      if (dispose) {
        dispose.call({});
        onSubscribeCancelMap.delete(subscribeId);
      }
    };
    const forSubscribleCancel = subjectName + FOR_SUBSCRIBLE_CANCEL_SUFFIX;
    const forSubscribleCancelDisposable = this.onNotify(forSubscribleCancel, subscribleCancelNotifyHandler);

    return Disposable.from(
      () => forSubscribleDisposable.dispose(),
      () => forSubscribleCancelDisposable.dispose(),
      ...Array.from(onSubscribeCancelMap.values()),
      () => this.onSubscribeSubjectSet.delete(subjectName),
    );
  }

  private onCallForQueryMode() {
    this.onCall(INNER_ONCALL_FOR_QUERY_MODE, ([queryName]: string[]) => {
      let mode: ExposeMode = 'call';
      if (this.notifyHandlerMap.has(queryName)) {
        mode = 'notify';
      } else if (this.callHandlerMap.has(queryName)) {
        mode = 'call';
      } else if (this.onSubscribeSubjectSet.has(queryName)) {
        mode = 'subscribe';
      } else {
        this.throwParamsInternalError(`the method ${queryName} is repeated`);
      }
      return mode;
    });
  }

  private receiveMessage() {
    const receiveHandler = (messageBody: MessageBody) => {
      if (
        messageBody.id != null &&
        isJsonrpcResponseBody(messageBody) &&
        validJsonrpcError((messageBody as JsonrpcResponseBody).error).isValid
      ) {
        this.msgSenderCtx.send(messageBody as JsonrpcResponseBody);
        return;
      }

      this.receiveMessageForOnCall(messageBody as JsonrpcRequestBody);
      this.receiveMessageForOnNotify(messageBody as JsonrpcRequestBody);
    };
    this.msgReceiverCtx.receive(receiveHandler);
  }

  private receiveMessageForOnCall(requestBody: JsonrpcRequestBody) {
    if (!(requestBody.id != null && isJsonrpcRequestBody(requestBody))) return;

    const { id, method, params } = requestBody;
    const callHandler = this.callHandlerMap.get(method);
    if (!callHandler) {
      const responseBody: JsonrpcResponseBody = {
        id,
        jsonrpc: '2.0',
        error: {
          code: JsonrpcErrorCode.MethodNotFound,
          message: `the method [${method}] not found`,
        },
      };
      this.msgSenderCtx.send(responseBody);
      return;
    }

    const invokeResult = invokeAsPromise(callHandler, params);
    const responseBody: JsonrpcResponseBody = {} as any;
    invokeResult
      .then((res: any) => (responseBody.result = res))
      .catch(
        (error) =>
          (responseBody.error = {
            code: JsonrpcErrorCode.ServerError,
            message: 'the call handler throw error',
            data: error.stack ?? error.toString(),
          }),
      )
      .finally(() => {
        responseBody.jsonrpc = '2.0';
        responseBody.id = id;
        this.msgSenderCtx.send(responseBody);
      });
  }

  private receiveMessageForOnNotify(requestBody: JsonrpcRequestBody) {
    if (!(requestBody.id == null && isJsonrpcRequestBody(requestBody))) return;

    const { method, params } = requestBody;
    const notifyHandler = this.notifyHandlerMap.get(method);
    if (notifyHandler) {
      notifyHandler.call({}, params);
    }
  }

  private throwParamsInternalError(message: string) {
    const internalError = {
      code: JsonrpcErrorCode.InternalError,
      message,
    };
    throw new JsonrpcCostomError(internalError);
  }
}
