// @flow

import type { Action, ActionType, Dispatch, Store } from '../types/redux'
import type { HorizonInstance, HorizonObservable } from '../types/horizon'
type ActionQueue = Array<Action>
type ActionTakerPattern = ActionType|Array<ActionType>|(a:Action)=>boolean
type ActionTakerObservableQuery = (hz:HorizonInstance, action:Action)=>HorizonObservable
type ActionTakerSuccessHandler = (result:any, action:Action, dispatch:Dispatch)=>void
type ActionTakerErrorHandler = (err:any, action:Action, dispatch:Dispatch)=>void
type ActionTakerType = string
type ActionTaker = {
  pattern: ActionTakerPattern,
  observableQuery: ActionTakerObservableQuery,
  successHandler?: ActionTakerSuccessHandler,
  errorHandler?: ActionTakerErrorHandler,
  subscribers: [],
  type: ActionTakerType
}
type ActionTakers = Array<ActionTaker>
type ActionTakerManager = {
  remove: ()=>void
}
type ActionTakerAdder = (
  pattern: ActionTakerPattern,
  observableQuery: ActionTakerObservableQuery,
  successHandler: ActionTakerSuccessHandler,
  errorHandler: ActionTakerErrorHandler
)=>ActionTakerManager

export default function HorizonRedux (hz: HorizonInstance) {
  if (typeof hz !== 'function') {
    throw new Error('must pass HorizonRedux a Horizon.io client instance')
  }

  let actionTakers:ActionTakers = []

  // initialize reduxDispatch
  // gets replaced with real dispatch when store applies horizon-redux middleware
  let reduxDispatch:Dispatch = () => {
    throw new Error('Trying to dispatch from HorizonRedux without Redux store')
  }

  let horizonReady:bool = false
  let actionQueue:ActionQueue = []

  const _hzHandleAction = (action:Action, dispatch:Dispatch, next?:Dispatch) => {
    actionTakers.forEach((actionTaker) => {
      if (
        (typeof actionTaker.pattern === 'string' && actionTaker.pattern === action.type) ||
        (Array.isArray(actionTaker.pattern) && actionTaker.pattern.indexOf(action.type) !== -1) ||
        (typeof actionTaker.pattern === 'function' && actionTaker.pattern(action))
      ) {
        const observable = actionTaker.observableQuery(hz, action)

        // if this actionTaker's query has a success or error handler, set up
        // the new subscription
        if (actionTaker.successHandler || actionTaker.errorHandler) {
          // set up observableQuery subscriber
          const subscriber = observable.subscribe(
            actionTaker.successHandler
              // $FlowIssue: not detecting above conditional
              ? (result) => actionTaker.successHandler(result, action, dispatch)
              : undefined,
            actionTaker.errorHandler
              // $FlowIssue: not detecting above conditional
              ? (err) => actionTaker.errorHandler(err, action, dispatch) // eslint-disable-line handle-callback-err
              : undefined
          )

          // add observable to actionTaker's subscribers so it can be
          // unsubscribed if the actionTaker is removed
          if (actionTaker.type === 'takeEvery') {
            actionTaker.subscribers.push(subscriber)
          } else if (actionTaker.type === 'takeLatest') {
            // Ensure that this actionTaker has only one active subscription,
            // which is based on the latest matching action dispatched
            actionTaker.subscribers.forEach((subscriber) => {
              subscriber.unsubscribe()
            })
            actionTaker.subscribers = [subscriber]
          }
          console.log(actionTaker.pattern, 'subscribers:', actionTaker.subscribers)
        }
      }
    })

    // only call next if it's provided in args.
    // it's omitted when iterating through actionQueue so duplicate actions are
    // stopped by the middleware, since they already passed through when first called.
    if (typeof next === 'function') {
      return next(action)
    }
  }

  hz.onReady().subscribe(() => {
    horizonReady = true
    actionQueue.forEach((action) => {
      // Next is omitted from _hzHandleAction here because we don't want to
      // dispatch these queued actions again (they were already passed down the
      // chain when they were initially dispatched). We only want HorizonRedux
      // replaying them to itself.
      _hzHandleAction(action, reduxDispatch)
    })
  })
  hz.onDisconnected().subscribe(() => {
    horizonReady = false
    reduxDispatch({ type: 'HORIZON_DISCONNECTED' })
  })

  const createMiddleware = () => ({ dispatch, getState }: Store) => {
    // give HorizonRedux access to dispatch
    reduxDispatch = dispatch

    return (next: Dispatch) => (action: Action) => {
      if (horizonReady) {
        _hzHandleAction(action, dispatch, next)
      } else {
        actionQueue.push(action)
        return next(action)
      }
    }
  }

  const addActionTaker: (
    pattern: ActionTakerPattern,
    observableQuery: ActionTakerObservableQuery,
    successHandler: ActionTakerSuccessHandler,
    errorHandler: ActionTakerErrorHandler,
    type: ActionTakerType
  )=>ActionTakerManager = (pattern, observableQuery, successHandler, errorHandler, type = 'takeEvery') => {
    if (
      typeof pattern !== 'string' &&
      !Array.isArray(pattern) &&
      typeof pattern !== 'function'
    ) {
      throw new Error('pattern must be a string, array of strings, or function')
    }

    if (typeof observableQuery !== 'function') {
      throw new Error('observableQuery must be a function that returns an observable horizon query')
    }

    if (successHandler && typeof successHandler !== 'function') {
      throw new Error('successHandler must be a function')
    }

    if (errorHandler && typeof errorHandler !== 'function') {
      throw new Error('errorHandler must be a function')
    }

    const actionTaker = {
      pattern,
      observableQuery,
      successHandler,
      errorHandler,
      type,
      subscribers: []
    }

    actionTakers.push(actionTaker)

    const remove = () => {
      // unsubscribe from all of this actionTaker's subscribers
      actionTaker.subscribers.forEach((subscriber) => {
        subscriber.unsubscribe()
      })
      // remove this actionTaker from actionTakers array
      actionTakers.splice(actionTakers.indexOf(actionTaker), 1)
    }

    return {
      remove
    }
  }

  const takeEvery: ActionTakerAdder = (pattern, observableQuery, successHandler, errorHandler, type) => addActionTaker(pattern, observableQuery, successHandler, errorHandler, 'takeEvery')

  const takeLatest: ActionTakerAdder = (pattern, observableQuery, successHandler, errorHandler, type) => addActionTaker(pattern, observableQuery, successHandler, errorHandler, 'takeLatest')

  return {
    createMiddleware,
    addActionTaker,
    takeEvery,
    takeLatest
  }
}
