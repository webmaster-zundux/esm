import Compiler from "../caching-compiler.js"
import Entry from "../entry.js"
import Module from "../module.js"
import Package from "../package.js"
import { REPLServer } from "repl"
import Runtime from "../runtime.js"
import Wrapper from "../wrapper.js"

import binding from "../binding.js"
import builtinEntries from "../builtin-entries.js"
import call from "../util/call.js"
import captureStackTrace from "../error/capture-stack-trace.js"
import clone from "../module/clone.js"
import getCacheFileName from "../util/get-cache-file-name.js"
import has from "../util/has.js"
import isCheck from "../env/is-check.js"
import isError from "../util/is-error.js"
import isEval from "../env/is-eval.js"
import isREPL from "../env/is-repl.js"
import isStackTraceMasked from "../util/is-stack-trace-masked.js"
import makeRequireFunction from "../module/make-require-function.js"
import maskStackTrace from "../error/mask-stack-trace.js"
import rootModule from "../root-module.js"
import setProperty from "../util/set-property.js"
import shared from "../shared.js"
import toNullObject from "../util/to-null-object.js"
import validateESM from "../module/esm/validate.js"
import wrap from "../util/wrap.js"

const ExObject = __external__.Object

function hook(vm) {
  let entry
  const pkg = Package.get("")

  const builtinModules = [
    "assert", "async_hooks", "buffer", "child_process", "cluster", "crypto",
    "dgram", "dns", "domain", "events", "fs", "http", "http2", "https", "net",
    "os", "path", "perf_hooks", "punycode", "querystring", "readline", "repl",
    "stream", "string_decoder", "tls", "tty", "url", "util", "v8", "vm", "zlib"
  ]

  if (typeof binding.inspector.connect === "function") {
    builtinModules.push("inspector")
    builtinModules.sort()
  }

  function managerWrapper(manager, func, args) {
    const wrapped = Wrapper.find(vm, "createScript", pkg.range)

    return Reflect.apply(wrapped, this, [manager, func, args])
  }

  function methodWrapper(manager, func, args) {
    let [content, scriptOptions] = args
    scriptOptions = toNullObject(scriptOptions)

    if (! scriptOptions.produceCachedData) {
      scriptOptions.produceCachedData = true
    }

    entry.cacheName = getCacheFileName(entry, content)

    let cached = entry.package.cache.compile[entry.cacheName]

    if (cached) {
      if (cached.scriptData &&
          scriptOptions.produceCachedData &&
          ! has(scriptOptions, "cachedData")) {
        scriptOptions.cachedData = cached.scriptData
      }
    } else {
      cached = tryWrapper(Compiler.compile, [
        entry,
        content,
        {
          strict: false,
          type: "unambiguous",
          var: true,
          warnings: false
        }
      ])
    }

    entry.state = 1

    if (cached.esm) {
      tryValidateESM(manager, entry, content)
    }

    entry.state = 3

    const { runtimeName } = entry

    content =
      "(()=>{" +
        'var g=Function("return this")(),' +
        "m=g.module," +
        "e=m&&m.exports," +
        'k="' + runtimeName + '";' +
        "if(e&&!g[k]){" +
          "m.exports=e.entry.exports;" +
          "require=e.entry.require;" +
          "e.entry.addBuiltinModules(g);" +
          "Object.defineProperty(g,k,{" +
            "__proto__:null," +
            "value:e" +
          "})" +
        "}" +
      "})();" +
      cached.code

    const result = tryWrapper(func, [content, scriptOptions])

    if (result.cachedDataProduced) {
      cached.scriptData = result.cachedData
    }

    result.runInContext = wrap(result.runInContext, tryWrapper)
    result.runInThisContext = wrap(result.runInThisContext, tryWrapper)
    return result
  }

  function addBuiltinModules(context) {
    for (const name of builtinModules) {
      const set = (value) => {
        setProperty(context, name, { value })
      }

      setProperty(context, name, {
        enumerable: false,
        get() {
          const exported = entry.require(name)

          setProperty(context, name, {
            enumerable: false,
            get: () => exported,
            set
          })

          return exported
        },
        set
      })
    }
  }

  function initEntry(mod) {
    entry = Entry.get(mod)
    entry.addBuiltinModules = addBuiltinModules
    entry.package = pkg
    entry.require = makeRequireFunction(clone(mod))
    entry.runtimeName = shared.globalName
    Runtime.enable(entry, new ExObject)
  }

  Wrapper.manage(vm, "createScript", managerWrapper)
  Wrapper.wrap(vm, "createScript", methodWrapper)

  if (isCheck()) {
    const { Script } = vm

    vm.Script = function (code, options) {
      vm.Script = Script
      const { wrapper } = Module
      code = code.slice(wrapper[0].length, -wrapper[1].length)
      initEntry(rootModule)
      return vm.createScript(code, options)
    }
  } else if (isEval())  {
    const { runInThisContext } = vm

    vm.runInThisContext = function (code, options) {
      vm.runInThisContext = runInThisContext
      initEntry(global.module)
      return vm.createScript(code, options).runInThisContext(options)
    }
  } else if (isREPL()) {
    const { createContext } = REPLServer.prototype

    if (rootModule.id === "<repl>") {
      initEntry(rootModule)
    } else {
      if (typeof createContext === "function") {
        REPLServer.prototype.createContext = function () {
          REPLServer.prototype.createContext = createContext
          const context = call(createContext, this)
          initEntry(context.module)
          return context
        }
      }

      const { support } = shared

      if (support.inspectProxies) {
        const util = __non_webpack_require__("util")
        const _inspect = util.inspect
        const { inspect } = builtinEntries.util.module.exports

        setProperty(util, shared.symbol.inspect, {
          enumerable: false,
          value: true
        })

        if (support.replShowProxy) {
          util.inspect = inspect
        } else {
          setProperty(util, "inspect", {
            get() {
              util.inspect = inspect
              return _inspect
            },
            set(value) {
              setProperty(util, "inspect", { value })
            }
          })
        }
      }
    }
  }
}

function tryValidateESM(caller, entry, content) {
  try {
    validateESM(entry)
  } catch (e) {
    if (! isError(e) ||
        isStackTraceMasked(e)) {
      throw e
    }

    const { filename } = entry.module

    captureStackTrace(e, caller)
    throw maskStackTrace(e, content, filename, true)
  }
}

function tryWrapper(func, args) {
  try {
    return Reflect.apply(func, this, args)
  } catch (e) {
    if (! isError(e) ||
        isStackTraceMasked(e)) {
      throw e
    }

    const [content] = args
    const isESM = e.sourceType === "module"

    delete e.sourceType
    throw maskStackTrace(e, content, null, isESM)
  }
}

export default hook
