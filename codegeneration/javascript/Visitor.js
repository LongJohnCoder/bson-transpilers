/* eslint complexity: 0 */
const ECMAScriptVisitor = require('../../lib/ECMAScriptVisitor').ECMAScriptVisitor;
const bson = require('bson');
const Context = require('context-eval');
const {
  SemanticArgumentCountMismatchError,
  SemanticTypeError,
  SemanticReferenceError,
  SemanticAttributeError
} = require('../../helper/error');

/**
 * This is a Visitor superclass where helper methods used by all language
 * generators can be defined.
 *
 * @returns {object}
 */
class Visitor extends ECMAScriptVisitor {
  constructor() {
    super();
    this.new = '';
  }

  start(ctx) {
    return this.visitExpressionSequence(ctx);
  }

  /**
   * Selectively visits children of a node.
   *
   * @param {ParserRuleContext} ctx
   * @param {Object} options:
   *    start - child index to start iterating at.
   *    end - child index to end iterating after.
   *    step - how many children to increment each step, 1 visits all children.
   *    separator - a string separator to go between children.
   *    ignore - an array of child indexes to skip.
   *    children - the set of children to visit.
   * @returns {String}
   */
  visitChildren(ctx, options) {
    const opts = {
      start: 0, step: 1, separator: '', ignore: [], children: ctx.children
    };
    Object.assign(opts, options ? options : {});
    opts.end = ('end' in opts) ? opts.end : opts.children.length - 1;

    let code = '';
    for (let i = opts.start; i <= opts.end; i += opts.step) {
      if (opts.ignore.indexOf(i) === -1) {
        code += this.visit(opts.children[i]) + (i === opts.end ? '' : opts.separator);
      }
    }
    /* Set the node's type to the first child, if it's not already set.
      More often than not, type will be set directly by the visitNode method. */
    if (ctx.type === undefined) {
      ctx.type = opts.children.length ? opts.children[0].type : this.Types._undefined;
    }
    return code.trim();
  }

  /**
   * Child nodes: literal
   * @param {LiteralExpressionContext} ctx
   * @return {String}
   */
  visitLiteralExpression(ctx) {
    ctx.type = this.getPrimitiveType(ctx.literal());

    if (`emit${ctx.type.id}` in this) {
      return this[`emit${ctx.type.id}`](ctx);
    }

    if (ctx.type.template) {
      return ctx.type.template(this.visitChildren(ctx));
    }

    return this.visitChildren(ctx);
  }

  /**
   * Child nodes: propertyNameAndValueList?
   * @param {ObjectLiteralContext} ctx
   * @return {String}
   */
  visitObjectLiteral(ctx) {
    ctx.type = this.Types._object;
    let args = '';
    if (ctx.propertyNameAndValueList()) {
      const properties = ctx.propertyNameAndValueList().propertyAssignment();
      if (ctx.type.argsTemplate) {
        args = ctx.type.argsTemplate(properties.map((pair) => {
          return [this.visit(pair.propertyName()), this.visit(pair.singleExpression())];
        }));
      }
    }
    if (ctx.type.template) {
      return ctx.type.template(args);
    }
  }

  /**
   * Child nodes: elementList*
   * @param {ArrayLiteralContext} ctx
   * @return {String}
   */
  visitArrayLiteral(ctx) {
    ctx.type = this.Types._array;
    let args = '';
    if (ctx.elementList()) {
      const children = ctx.elementList().children.filter((child) => {
        return child.constructor.name !== 'TerminalNodeImpl';
      });
      if (ctx.type.argsTemplate) {
        args = ctx.type.argsTemplate(children.map((c) => { return this.visit(c); }));
      } else {
        args = children.map((c) => { return this.visit(c); }).join(', ');
      }
    }
    if (ctx.type.template) {
      return ctx.type.template(args);
    }
  }

  /**
   * One terminal child.
   * @param {ElisionContext} ctx
   * @return {String}
   */
  visitElision(ctx) {
    ctx.type = this.Types._null;
    if (ctx.type.template) {
      return ctx.type.template();
    }
    return 'null';
  }


  /**
   * Child nodes: singleExpression arguments
   * @param {FuncCallExpressionContext} ctx
   * @return {String}
   */
  visitFuncCallExpression(ctx) {
    const lhs = this.visit(ctx.singleExpression());
    let lhsType = ctx.singleExpression().type;
    if (typeof lhsType === 'string') {
      lhsType = this.Types[lhsType];
    }

    // Special case
    if (`emit${lhsType.id}` in this) {
      return this[`emit${lhsType.id}`](ctx);
    }

    // Check if callable
    ctx.type = lhsType.type;
    if (!lhsType.callable) {
      throw new SemanticTypeError({
        message: `${lhsType.id} is not callable`
      });
    }

    // Check arguments
    const expectedArgs = lhsType.args;
    let rhs = this.checkArguments(expectedArgs, ctx.arguments().argumentList());

    // Add new if needed
    const newStr = lhsType.callable === this.SYMBOL_TYPE.CONSTRUCTOR ? this.new : '';
    if (lhsType.argsTemplate) {
      let l = lhs;
      if ('identifierName' in ctx.singleExpression()) {
        l = this.visit(ctx.singleExpression().singleExpression());
      }
      rhs = lhsType.argsTemplate(l, ...rhs);
    } else {
      rhs = `(${rhs.join(', ')})`;
    }
    return `${newStr}${lhs}${rhs}`;
  }

  visitIdentifierExpression(ctx) {
    const name = this.visitChildren(ctx);
    ctx.type = this.Symbols[name];
    if (ctx.type === undefined) {
      throw new SemanticReferenceError({
        message: `symbol "${name}" is undefined`
      });
    }
    if (ctx.type.template) {
      return ctx.type.template();
    }
    return name;
  }

  /**
   * This will check the type of the attribute, and error if it's a BSON symbol
   * or a JS Symbol and it is undefined. If it's not either of those symbols, it
   * doesn't error. TODO: should always error? never error?
   *
   * Child nodes: singleExpression identifierName
   * @param {GetAttributeExpressionContext} ctx
   * @return {String}
   */
  visitGetAttributeExpression(ctx) {
    const lhs = this.visit(ctx.singleExpression());
    const rhs = this.visit(ctx.identifierName());

    let type = ctx.singleExpression().type;
    if (typeof type === 'string') {
      type = this.Types[type];
    }
    while (type !== null) {
      if (!(type.attr.hasOwnProperty(rhs))) {
        if (type.id in this.BsonSymbols && this.BsonSymbols.type.id !== null) {
          throw new SemanticAttributeError({
            message: `${rhs} not an attribute of ${type.id}`
          });
        }
        type = type.type;
        if (typeof type === 'string') {
          type = this.Types[type];
        }
      } else {
        break;
      }
    }
    if (type === null) {
      ctx.type = this.Types._undefined;
      // TODO: how strict do we want to be?
      return `${lhs}.${rhs}`;
    }
    ctx.type = type.attr[rhs];
    if (type.attr[rhs].template) {
      return type.attr[rhs].template(lhs, rhs);
    }

    return `${lhs}.${rhs}`;
  }

  visitNewExpression(ctx) {
    if ('emitNew' in this) {
      return this.emitNew(ctx);
    }
    return this.visitChildren(ctx);
  }

  visitRegularExpressionLiteral(ctx) {
    if ('emitRegExp' in this) {
      return this.emitRegExp(ctx);
    }
    return this.visitChildren(ctx);
  }

  /**
   * Visit a leaf node and return a string.
   * *
   * @param {ParserRuleContext} ctx
   * @returns {String}
   */
  visitTerminal(ctx) {
    return ctx.getText();
  }

  // //////////
  // Helpers //
  // //////////
  /**
   * Get the type of a node. TODO: nicer way to write it?
   * @param {LiteralContext} ctx
   * @return {Symbol}
   */
  getPrimitiveType(ctx) {
    if ('NullLiteral' in ctx) {
      return this.Types._null;
    }
    if ('UndefinedLiteral' in ctx) {
      return this.Types._undefined;
    }
    if ('BooleanLiteral' in ctx) {
      return this.Types._bool;
    }
    if ('StringLiteral' in ctx) {
      return this.Types._string;
    }
    if ('RegularExpressionLiteral' in ctx) {
      return this.Types._regex;
    }
    if ('numericLiteral' in ctx) {
      const number = ctx.numericLiteral();
      if ('IntegerLiteral' in number) {
        return this.Types._integer;
      }
      if ('DecimalLiteral' in number) {
        return this.Types._decimal;
      }
      if ('HexIntegerLiteral' in number) {
        return this.Types._hex;
      }
      if ('OctalIntegerLiteral' in number) {
        return this.Types._octal;
      }
    }
    // TODO: or raise error?
    return this.Types._undefined;
  }

  executeJavascript(input) {
    const sandbox = {
      RegExp: RegExp,
      BSONRegExp: bson.BSONRegExp,
      Binary: bson.Binary,
      DBRef: bson.DBRef,
      Decimal128: bson.Decimal128,
      Double: bson.Double,
      Int32: bson.Int32,
      Long: bson.Long,
      Int64: bson.Long,
      Map: bson.Map,
      MaxKey: bson.MaxKey,
      MinKey: bson.MinKey,
      ObjectID: bson.ObjectID,
      ObjectId: bson.ObjectID,
      Symbol: bson.Symbol,
      Timestamp: bson.Timestamp,
      Code: function(c, s) {
        return new bson.Code(c, s);
      },
      NumberDecimal: function(s) {
        return bson.Decimal128.fromString(s);
      },
      NumberInt: function(s) {
        return parseInt(s, 10);
      },
      NumberLong: function(v) {
        return bson.Long.fromNumber(v);
      },
      ISODate: function(s) {
        return new Date(s);
      },
      Date: function(s) {
        const args = Array.from(arguments);

        if (args.length === 1) {
          return new Date(s);
        }

        return new Date(Date.UTC(...args));
      },
      Buffer: Buffer,
      __result: {}
    };
    const ctx = new Context(sandbox);
    const res = ctx.evaluate('__result = ' + input);
    ctx.destroy();
    return res;
  }

  /**
   *
   * @param {Array} expected - An array of arrays where each subarray represents
   * possible argument types for that index.
   * @param {ArgumentListContext} argumentList - null if empty.
   *
   * @returns {Array}
   */
  checkArguments(expected, argumentList) {
    const argStr = [];
    if (!argumentList) {
      if (expected.length === 0) {
        return argStr;
      }
      throw new SemanticArgumentCountMismatchError({message: 'arguments required'});
    }
    const args = argumentList.singleExpression();
    if (args.length > expected.length) {
      throw new SemanticArgumentCountMismatchError({
        message: `Arguments mismatch: expected ${expected.length} and got ${args.length}`
      });
    }
    for (let i = 0; i < expected.length; i++) {
      if (args[i] === undefined) {
        if (expected[i].indexOf(null) !== -1) {
          return argStr;
        }
        throw new SemanticArgumentCountMismatchError({message: 'too few arguments'});
      }
      argStr.push(this.visit(args[i]));
      if (expected[i].indexOf(this.Types._numeric) !== -1 && (
          args[i].type === this.Types._integer ||
          args[i].type === this.Types._decimal ||
          args[i].type === this.Types._hex ||
          args[i].type === this.Types._octal)) {
        continue;
      }
      if (expected[i].indexOf(args[i].type) === -1 && expected[i].indexOf(args[i].type.id) === -1) {
        const message = `expected types ${expected[i].map((e) => {
          return e.id ? e.id : e;
        })} but got type ${args[i].type.id} for argument at index ${i}`;

        throw new SemanticTypeError({message});
      }
    }
    return argStr;
  }
}

module.exports = Visitor;
