const {Subject, of} = require('rxjs')
const {finalize, first, map, filter, catchError} = require('rxjs/operators')
const {Worker, MessageChannel} = require('worker_threads')
const path = require('path')
const _ = require('lodash')
const Transport = require('./transport')
const {service} = require('@sepal/service')

const WORKER_PATH = path.join(__dirname, 'worker.js')

const bootstrapWorker$ = ({workerId, jobName, logConfig}) => {
    const worker$ = new Subject()
    const worker = new Worker(WORKER_PATH)
    const {port1: localPort, port2: remotePort} = new MessageChannel()
    worker.on('message', message => {
        message.ready && worker$.next({worker, port: localPort})
    })
    worker.postMessage({workerId, jobName, logConfig, port: remotePort}, [remotePort])
    return worker$.pipe(
        first()
    )
}

const setupWorker = ({workerId, jobName, jobPath, worker, port}) => {
    const disposables = []
    const transport = Transport({port, jobName, workerId})

    transport.onChannel(
        ({conversationId: serviceId, in$: response$, out$: request$}) => {
            if (serviceId) {
                const serviceName = serviceId.substring(0, serviceId.lastIndexOf(':'))
                service.start(serviceName, request$, response$)
            }
        }
    )
 
    const submit$ = ({requestId, initArgs, args, args$, cmd$}) => {
        const {in$: request$, out$: response$} = transport.createChannel('job')

        const start = () =>
            request$.next({start: {requestId, jobPath, initArgs, args}})

        const stop = () =>
            request$.complete()

        args$ && args$.subscribe(
            value => request$.next({next: {requestId, value}})
            // [TODO] handle error
        )

        cmd$ && cmd$.subscribe(
            cmd => request$.next({next: {requestId, cmd}})
        )

        start()

        return response$.pipe(
            catchError(error => of({requestId, error: true, value: error})),
            filter(message => message.requestId === requestId),
            finalize(() => stop())
        )
    }

    const dispose = () => {
        worker.terminate()
        _.forEach(disposables, disposable => disposable.dispose())
    }

    return {
        submit$,
        dispose
    }
}

const initWorker$ = ({workerId, jobName, jobPath, logConfig}) =>
    bootstrapWorker$({workerId, jobName, logConfig}).pipe(
        map(({worker, port}) =>
            setupWorker({workerId, jobName, jobPath, worker, port})
        )
    )

const WORKER = Symbol()

module.exports = {initWorker$, WORKER}
