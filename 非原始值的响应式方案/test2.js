const obj = {
    foo: 1,
}

const ITERATE_KEY= Symbol()

// 存储副作用函数的桶
const bucket = new WeakMap();

const TriggerType = {
    SET: 'SET',
    ADD: 'ADD',
    DELETE: 'DELETE'
}

const p = new Proxy(obj, {
    // 拦截读取操作,接收第三个参数receiver
    get(target, key, receiver) {
        // 将副作用函数activeEffect添加到存储副作用函数的桶中
        track(target, key);
        // 使用Reflect.get返回读取到的属性值
        return Reflect.get(target, key, receiver)
    },
    set(target, key, newVal, receiver) {
        // 如果属性不存在,则说明是在添加新属性,否则是设置已有属性
        const type = Object.prototype.hasOwnProperty.call(target, key) ? TriggerType.SET : TriggerType.ADD
        // 设置属性值
        const res = Reflect.set(target, key, newVal, receiver)
        // 把副作用函数从桶里取出并执行
        trigger(target, key, type)
        return res
    },
    has(target, key) {
        track(target, key)
        return Reflect.has(target, key)
    },
    ownKeys(target) {
        // 将副作用函数与ITERATE_KEY关联
        track(target, ITERATE_KEY)
        return Reflect.ownKeys(target)
    },
    deleteProperty(target, key) {
        // 检查被操作的属性是否是对象自己的属性
        const hadKey = Object.prototype.hasOwnProperty.call(target, key)
        // 使用Reflect.deleteProperty完成属性的删除
        const res = Reflect.deleteProperty(target, key)

        if (res && hadKey) {
            trigger(target, key, TriggerType.DELETE)
        }

        return res
    }
})


function track (target, key) {
    // 没有activeEffect,直接return
    if (!activeEffect) return
    // 根据target从“桶”中取得depsMap, 它也是一个Map类型: key --> effects
    let depsMap = bucket.get(target)
    // 如果不存在depsMap,那么新建一个Map并与target关联
    if (!depsMap) {
        bucket.set(target, (depsMap = new Map()))
    }
    // 再根据key从depsMap中取得deps,它是一个Set类型
    // 里面存储着所有与当前key相关联的副作用函数: effects
    let deps = depsMap.get(key)
    // 如果deps不存在,同样新建一个Set并与key关联
    if (!deps) {
        depsMap.set(key, (deps = new Set()))
    }
    // 最后将当前激活的副作用函数添加到“桶”里
    deps.add(activeEffect)
    // deps就是一个与当前副作用函数存在联系的依赖集合
    // 将其添加到activeEffect.deps 数组中
    activeEffect.deps.push(deps)
}

function trigger (target, key, type) {
    // 根据target从桶中取得depsMap,它是: key --> effects
    const depsMap = bucket.get(target);
    if (!depsMap) return
    // 根据key取得所有副作用函数effects
    const effects = depsMap.get(key);

    const effectsToRun = new Set()
    // 将与key相关联的副作用函数添加到effectsToRun
    effects && effects.forEach(effectFn => {
        if (effectFn !== activeEffect) {
            effectsToRun.add(effectFn)
        }
    })

    if (type === TriggerType.ADD || type === TriggerType.DELETE) {
        // 取得与ITERATE_KEY相关联的副作用函数
        const iterateEffects = depsMap.get(ITERATE_KEY)
        // 将与ITERATE_KEY相关联的副作用函数添加到effectsToRun
        iterateEffects && iterateEffects.forEach(effectFn => {
            if (effectFn !== activeEffect) {
                effectsToRun.add(effectFn)
            }
        })
    }
    effectsToRun.forEach(effectFn => {
        // 如果一个副作用函数存在调度器, 则调用该调度器, 并将副作用函数作为参数传递
        if (effectFn.optiopns.scheduler) { // 新增
            effectFn.optiopns.scheduler(effectFn) // 新增
        } else {
            // 否则直接执行副作用函数(之前的默认行为)
            effectFn()
        }
    })
}


let activeEffect

// effect栈
const effectStack = []


function effect(fn, optiopns = {}) {
    const effectFn = () => {
        // 调用cleanup函数完成清除工作
        cleanup(effectFn)
        // 当effectFn执行时,将其设置为当前激活的副作用函数
        activeEffect = effectFn

        // 在调用副作用函数之前将当前副作用函数压入栈中
        effectStack.push(effectFn)
        const res = fn()
        // 在当前副作用函数执行完毕后,将当前副作用函数弹出栈,并把acticeEffect还原为之前的值
        effectStack.pop();
        activeEffect = effectStack[effectStack.length - 1]
        // 将res作为effectFn的返回值
        return res
    }
    // 将options挂载到effectFn上
    effectFn.optiopns = optiopns
    // activeEffect.deps用来存储所有与该副作用函数相关联的依赖集合
    effectFn.deps = []
    // 只有非lazy的时候才执行
    if (!optiopns.lazy) {
        effectFn()
    }
    // 执行副作用函数
    return effectFn
}

function cleanup (effectFn) {
    //遍历effectFn.deps数组
    for (let i = 0; i < effectFn.deps.length; i ++) {
        //deps是依赖集合
        const deps = effectFn.deps[i]
        // 将effectFn从依赖集合中移除
        deps.delete(effectFn)
    }
    // 最后需要重置effectFn.deps数组
    effectFn.deps.length = 0
}


function traverse(value, seen = new Set()) {
    // 如果要读取的数据是原始值,或者已经被读取过,那么什么都不做
    if (typeof value !== 'object' || value === null || seen.has(value)) return
    // 将数据添加到seen中,代表遍历地读取过了,避免循环引用引起的死循环
    seen.add(value)
    // 暂时不考虑数组等其他结构
    // 假设value就是一个对象,使用for in 读取对象的每一个值,并递归的调用tarverse进行处理
    for (const k in value) {
        traverse(value[k], seen)
    }

    return value
}

function watch(source, cb, options = {}) {
    // 定义getter
    let getter
    // 如果source是函数,说明用户传递的是getter,所以直接把source赋值给getter
    if (typeof source === 'function') {
        getter = source
    } else {
        // 否则按照原来的实现调用traverse递归的读取
        getter = () => traverse(source)
    }
    // 定义旧值与新值
    let oldValue, newValue

    // cleanup用来存储用户注册的过期回调
    let cleanup
    // 定义onInvalidate函数
    function onInvalidate(fn) {
        // 将过期回调存储到cleanup中
        cleanup = fn
    }

    // 提取scheduler调度函数为一个独立的job函数
    const job = () => {
        newValue = effectFn()
        // 在调用回调函数cb之前,先调用过期回调
        if (cleanup) {
            cleanup()
        }
        // 将onInvalidate作为回调函数的第三个参数,以便用户使用
        cb(newValue, oldValue, onInvalidate)
        oldValue = newValue
    }

    // 使用effect注册副作用函数时,开启lazy选项,并把返回值存储到effectFn中以便后续手动调用
    const effectFn = effect (
        // 执行getter
        () => getter(),
        {
            lazy: true,
            scheduler: () => {
                if (options.flush === 'post') {
                    const p = Promise.resolve()
                    p.then(job)
                } else {
                    job()
                }
            }
        }
    )

    if (options.immediate) {
        // 当immediate为true时立即执行
        job()
    } else {
        // 手动调用副作用函数,拿到的值就是旧值
        oldValue = effectFn()
    }
}

// effect(() => {
//    console.log( 'foo' in p)
// })

effect(() => {
   // for...in循环
   for (const key in p) {
    console.log(key)
   }
})
// p.foo ++ 
p.bar = 2

delete p.bar