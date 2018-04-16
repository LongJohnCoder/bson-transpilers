const path = require('path');

const {
  SemanticArgumentCountMismatchError,
  SemanticGenericError,
  SemanticTypeError
} = require(path.resolve('helper', 'error'));
const {Types} = require('../SymbolTable');

/**
 * This Visitor walks the tree generated by parsers and produces Python code.
 *
 * @returns {object}
 */
module.exports = (superclass) => {
  class Visitor extends superclass {
    // /////////////////////////// //
    // Nodes that differ in syntax //
    // /////////////////////////// //

    /**
     * Visits String Literal
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitStringLiteral(ctx) {
      ctx.type = Types._string;

      return this.singleQuoteStringify(this.visitChildren(ctx));
    }

    /**
     * Visits Property Name And Value List
     *
     * @param {PropertyNameAndValueListContext} ctx
     * @return {String}
     */
    visitPropertyNameAndValueList(ctx) {
      return this.visitChildren(
        ctx,
        {children: ctx.propertyAssignment(), separator: ', '}
      );
    }

    /**
     * Visit Property Assignment Expression
     * Child nodes: propertyName singleExpression
     *
     * @param {PropertyAssignmentExpressionContext} ctx
     * @return {String}
     */
    visitPropertyAssignmentExpression(ctx) {
      const key = this.singleQuoteStringify(this.visit(ctx.propertyName()));
      const value = this.visit(ctx.singleExpression());

      return `${key}: ${value}`;
    }


    /**
     * Because Python doesn't need `New`, we can skip the first child
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitNewExpression(ctx) {
      const child = this.visitChildren(ctx, {start: 1});

      ctx.type = ctx.singleExpression().type;

      return child;
    }

    /**
     * Visits Object Literal
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitObjectLiteral(ctx) {
      ctx.type = Types._object;

      return this.visitChildren(ctx);
    }

    /**
     * Visits Element List
     * TODO: Is it okay to sort by terminal?
     * Child nodes: (elision* singleExpression*)+
     *
     * @param {ElementListContext} ctx
     * @return {String}
     */
    visitElementList(ctx) {
      const children = ctx.children.filter((child) => (
        child.constructor.name !== 'TerminalNodeImpl'
      ));

      return this.visitChildren(ctx, {children, separator: ', '});
    }

    /**
     * Visits Code Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitBSONCodeConstructor(ctx) {
      const argumentList = ctx.arguments().argumentList();

      if (
        argumentList === null ||
        (argumentList.getChildCount() !== 1 && argumentList.getChildCount() !== 3)
      ) {
        throw new SemanticArgumentCountMismatchError();
      }

      const argList = argumentList.singleExpression();
      const code = this.singleQuoteStringify(argList[0].getText());

      if (argList.length === 2) {
        /* NOTE: we have to visit the subtree first before type checking or type may
        not be set. We might have to just suck it up and do two passes, but maybe
        we can avoid it for now. */
        const scope = this.visit(argList[1]);

        if (argList[1].type !== Types._object) {
          throw new SemanticTypeError({
            message: 'Code requires scope to be an object'
          });
        }

        return `Code(${code}, ${scope})`;
      }

      return `Code(${code})`;
    }

    /**
     * This evaluates the code in a sandbox and gets the hex string out of the
     * ObjectId.
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitBSONObjectIdConstructor(ctx) {
      const argumentList = ctx.arguments().argumentList();

      if (argumentList === null) {
        return 'ObjectId()';
      }

      if (argumentList.getChildCount() !== 1) {
        throw new SemanticArgumentCountMismatchError({
          message: 'ObjectId requires zero or one argument'
        });
      }

      let hexstr;

      try {
        hexstr = this.executeJavascript(ctx.getText()).toHexString();
      } catch (error) {
        throw new SemanticGenericError({message: error.message});
      }

      return `ObjectId(${this.singleQuoteStringify(hexstr)})`;
    }

    /**
     * Visits Binary Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitBSONBinaryConstructor(ctx) {
      const argumentList = ctx.arguments().argumentList();
      let type = '';
      let binobj = {};
      const subtypes = {
        0: 'bson.binary.BINARY_SUBTYPE',
        1: 'bson.binary.FUNCTION_SUBTYPE',
        2: 'bson.binary.OLD_BINARY_SUBTYPE',
        3: 'bson.binary.OLD_UUID_SUBTYPE',
        4: 'bson.binary.UUID_SUBTYPE',
        5: 'bson.binary.MD5_SUBTYPE',
        6: 'bson.binary.CSHARP_LEGACY',
        128: 'bson.binary.USER_DEFINED_SUBTYPE'
      };

      if (
        argumentList === null ||
        (argumentList.getChildCount() !== 1 && argumentList.getChildCount() !== 3)
      ) {
        throw new SemanticArgumentCountMismatchError({
          message: 'Binary requires one or two argument'
        });
      }

      try {
        binobj = this.executeJavascript(ctx.getText());
        type = binobj.sub_type;
      } catch (error) {
        throw new SemanticGenericError({message: error.message});
      }

      const argList = argumentList.singleExpression();
      const bytes = this.singleQuoteStringify(binobj.toString());

      if (argList.length === 1) {
        return `Binary(bytes(${bytes}, 'utf-8'))`;
      }

      return `Binary(bytes(${bytes}, 'utf-8'), ${subtypes[type]})`;
    }

    /**
     * Visits Double Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitBSONDoubleConstructor(ctx) {
      const argumentList = ctx.arguments().argumentList();

      if (argumentList === null || argumentList.getChildCount() !== 1) {
        throw new SemanticArgumentCountMismatchError({
          message: 'Double requires one argument'
        });
      }

      const arg = argumentList.singleExpression()[0];
      const double = this.removeQuotes(this.visit(arg));

      if (
        arg.type !== Types._string &&
        arg.type !== Types._decimal &&
        arg.type !== Types._integer
      ) {
        throw new SemanticTypeError({
          message: 'Double requires a number or a string argument'
        });
      }

      return `float(${double})`;
    }

    /**
     * Visits Long Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitBSONLongConstructor(ctx) {
      const argumentList = ctx.arguments().argumentList();

      if (
        argumentList === null ||
        (argumentList.getChildCount() !== 1 && argumentList.getChildCount() !== 3)
      ) {
        throw new SemanticArgumentCountMismatchError({
          message: 'Long requires one or two argument'
        });
      }

      let longstr = '';

      try {
        longstr = this.executeJavascript(ctx.getText()).toString();
      } catch (error) {
        throw new SemanticGenericError({message: error.message});
      }

      return `Int64(${longstr})`;
    }

    /**
     * Visits Date Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitDateConstructorExpression(ctx) {
      const argumentList = ctx.arguments().argumentList();

      if (argumentList === null) {
        return 'datetime.datetime.utcnow().date()';
      }

      let dateStr = '';

      try {
        const date = this.executeJavascript(ctx.getText());

        dateStr = [
          date.getUTCFullYear(),
          (date.getUTCMonth() + 1),
          date.getUTCDate(),
          date.getUTCHours(),
          date.getUTCMinutes(),
          date.getUTCSeconds()
        ].join(', ');
      } catch (error) {
        throw new SemanticGenericError({message: error.message});
      }

      return `datetime.datetime(${dateStr}, tzinfo=datetime.timezone.utc)`;
    }

    /**
     * Visits Date Now Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitDateNowConstructorExpression() {
      return 'datetime.datetime.utcnow()';
    }

    /**
     * Visits Number Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitNumberConstructorExpression(ctx) {
      const argumentList = ctx.arguments().argumentList();

      if (argumentList === null || argumentList.getChildCount() !== 1) {
        throw new SemanticArgumentCountMismatchError({
          message: 'Number requires one argument'
        });
      }

      const arg = argumentList.singleExpression()[0];
      const number = this.removeQuotes(this.visit(arg));

      if (
        (
          arg.type !== Types._string &&
          arg.type !== Types._decimal &&
          arg.type !== Types._integer
        )
        || isNaN(Number(number))
      ) {
        throw new SemanticTypeError({
          message: 'Number requires a number or a string argument'
        });
      }

      return `int(${number})`;
    }

    /**
     * Visits MaxKey Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitBSONMaxKeyConstructor() {
      return 'MaxKey()';
    }

    /**
     * Visits MinKey Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitBSONMinKeyConstructor() {
      return 'MinKey()';
    }

    /**
     * Visits Symbol Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitBSONSymbolConstructor(ctx) {
      const argumentList = ctx.arguments().argumentList();

      if (argumentList === null || argumentList.getChildCount() !== 1) {
        throw new SemanticArgumentCountMismatchError({
          message: 'Symbol requires one argument'
        });
      }

      const arg = argumentList.singleExpression()[0];
      const symbol = this.visit(arg);

      if (arg.type !== Types._string) {
        throw new SemanticTypeError({
          message: 'Symbol requires a string argument'
        });
      }

      return `unicode(${symbol}, 'utf-8')`;
    }

    /**
     * Visit Object.create() Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitObjectCreateConstructorExpression(ctx) {
      const argumentList = ctx.arguments().argumentList();

      if (argumentList === null || argumentList.getChildCount() !== 1) {
        throw new SemanticArgumentCountMismatchError({
          message: 'Object.create() requires one argument'
        });
      }

      const arg = argumentList.singleExpression()[0];
      const obj = this.visit(arg);

      if (arg.type !== Types._object) {
        throw new SemanticTypeError({
          message: 'Object.create() requires an object argument'
        });
      }

      return obj;
    }

    /**
     * Visits Array Literal
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitArrayLiteral(ctx) {
      ctx.type = Types._array;

      return this.visitChildren(ctx);
    }

    /**
     * Visits Undefined Literal
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitUndefinedLiteral(ctx) {
      ctx.type = Types._undefined;

      return 'None';
    }

    /**
     * Visits Elision Literal
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitElision(ctx) {
      ctx.type = Types._null;

      return 'None';
    }

    /**
     * Visits Null Literal
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitNullLiteral(ctx) {
      ctx.type = Types._null;

      return 'None';
    }

    /**
     * Visits Octal Integer Literal
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitOctalIntegerLiteral(ctx) {
      ctx.type = Types._octal;

      let oct = this.visitChildren(ctx);
      let offset = 0;

      if (
        oct.charAt(0) === '0' &&
        (oct.charAt(1) === '0' || oct.charAt(1) === 'o' || oct.charAt(1) === 'O')
      ) {
        offset = 2;
      } else if (oct.charAt(0) === '0') {
        offset = 1;
      }

      oct = `0o${oct.substr(offset, oct.length - 1)}`;

      return oct;
    }

    /**
     * Visits BSON Timestamp Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitBSONTimestampConstructor(ctx) {
      const argumentList = ctx.arguments().argumentList();

      if (argumentList === null || argumentList.getChildCount() !== 3) {
        throw new SemanticArgumentCountMismatchError({
          message: 'Timestamp requires two arguments'
        });
      }

      const argList = argumentList.singleExpression();
      const low = this.visit(argList[0]);

      if (argList[0].type !== Types._integer) {
        throw new SemanticTypeError({
          message: 'Timestamp first argument requires integer arguments'
        });
      }

      const high = this.visit(argList[1]);

      if (argList[1].type !== Types._integer) {
        throw new SemanticTypeError({
          message: 'Timestamp second argument requires integer arguments'
        });
      }

      return `Timestamp(${low}, ${high})`;
    }

    /**
     * Visits Boolean Literal
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitBooleanLiteral(ctx) {
      ctx.type = Types._bool;

      const string = ctx.getText();

      return `${string.charAt(0).toUpperCase()}${string.slice(1)}`;
    }

    /**
     * Builds Regular Expression string
     * child nodes: arguments
     * grandchild nodes: argumentList?
     * great-grandchild nodes: singleExpression+
     *
     * @param {RegExpConstructorExpressionContext} ctx
     * @return {String}
     */
    buildRegExp(ctx) {
      const PYTHON_REGEX_FLAGS = {
        i: 'i', // re.IGNORECASE
        m: 'm', // re.MULTILINE
        u: 'a', // re.ASCII
        y: '', // Sticky flag matches only from the index indicated by the lastIndex property
        g: 's' // re.DOTALL matches all
        // re.DEBUG - Display debug information. No corresponding inline flag.
        // re.LOCALE - Case-insensitive matching dependent on the current locale. Inline flag (?L)
        // re.VERBOSE - More readable way of writing patterns (eg. with comments)
      };

      let pattern;
      let flags;

      try {
        const regexobj = this.executeJavascript(ctx.getText());

        pattern = regexobj.source;
        flags = regexobj.flags;
      } catch (error) {
        throw new SemanticGenericError({message: error.message});
      }

      // Double escape characters except for slashes
      const escaped = pattern.replace(/\\(?!\/)/, '\\\\');

      if (flags !== '') {
        flags = flags
          .split('')
          .map((item) => PYTHON_REGEX_FLAGS[item])
          .sort()
          .join('');

        return `re.compile(r${this.doubleQuoteStringify(`${escaped}(?${flags})`)})`;
      }

      return `re.compile(r${this.doubleQuoteStringify(escaped)})`;
    }

    /**
     * Visits RegExp Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitRegExpConstructorExpression(ctx) {
      return this.buildRegExp(ctx);
    }

    /**
     * Visits Regular Expression Literal
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitRegularExpressionLiteral(ctx) {
      return this.buildRegExp(ctx);
    }

    /**
     * Expects two strings as arguments, the second must be valid flag
     * child nodes: arguments
     * grandchild nodes: argumentList?
     * great-grandchild nodes: singleExpression+
     *
     * @param {BSONRegExpConstructorContext} ctx
     * @return {String}
     */
    visitBSONRegExpConstructor(ctx) {
      const argumentList = ctx.arguments().argumentList();
      const BSON_FLAGS = {
        'i': 'i', // Case insensitivity to match
        'm': 'm', // Multiline match
        'x': 'x', // Ignore all white space characters
        's': 's', // Matches all
        'l': 'l', // Case-insensitive matching dependent on the current locale?
        'u': 'u' // Unicode?
      };

      if (
        argumentList === null ||
        (argumentList.getChildCount() !== 1 && argumentList.getChildCount() !== 3)
      ) {
        throw new SemanticArgumentCountMismatchError({
          message: 'BSONRegExp requires one or two arguments'
        });
      }

      const args = argumentList.singleExpression();
      const pattern = this.visit(args[0]);

      if (args[0].type !== Types._string) {
        throw new SemanticTypeError({
          message: 'BSONRegExp requires pattern to be a string'
        });
      }

      if (args.length === 2) {
        let flags = this.visit(args[1]);

        if (args[1].type !== Types._string) {
          throw new SemanticTypeError({
            message: 'BSONRegExp requires flags to be a string'
          });
        }

        if (flags !== '') {
          const unsuppotedFlags = [];

          flags = this
            .removeQuotes(flags).split('')
            .map((item) => {
              if (Object.keys(BSON_FLAGS).includes(item) === false) {
                unsuppotedFlags.push(item);
              }

              return BSON_FLAGS[item];
            });

          if (unsuppotedFlags.length > 0) {
            throw new SemanticGenericError({
              message: `Regular expression contains unsuppoted '${unsuppotedFlags.join('')}' flag`
            });
          }

          flags = this.singleQuoteStringify(flags.join(''));
        }

        return `RegExp(${pattern}, ${flags})`;
      }
      return `RegExp(${pattern})`;
    }

    /**
     * Visits BSON DBRef Constructor
     * child nodes: arguments
     * grandchild nodes: argumentList?
     * great-grandchild nodes: singleExpression+
     *
     * @param {BSONDBRefConstructorContext} ctx
     * @return {String}
     */
    visitBSONDBRefConstructor(ctx) {
      const argumentList = ctx.arguments().argumentList();

      if (
        argumentList === null ||
        (argumentList.getChildCount() !== 3 && argumentList.getChildCount() !== 5)
      ) {
        throw new SemanticArgumentCountMismatchError({
          message: 'DBRef requires two or three arguments'
        });
      }

      const args = argumentList.singleExpression();
      const ns = this.visit(args[0]);

      if (args[0].type !== Types._string) {
        throw new SemanticTypeError({
          message: 'DBRef first argumnet requires string namespace'
        });
      }

      const oid = this.visit(args[1]);

      if (args[1].type !== Types._object) {
        throw new SemanticTypeError({
          message: 'DBRef requires object OID'
        });
      }

      if (args.length === 3) {
        const db = this.visit(args[2]);

        if (args[2].type !== Types._string) {
          throw new SemanticTypeError({
            message: 'DbRef requires string collection'
          });
        }

        return `DBRef(${ns}, ${oid}, ${db})`;
      }

      return `DBRef(${ns}, ${oid})`;
    }

    /**
     * Visits BSON Decimal128 Constructor
     *
     * @param {object} ctx
     * @returns {string}
     */
    visitBSONDecimal128Constructor(ctx) {
      const argumentList = ctx.arguments().argumentList();

      if (argumentList === null || argumentList.getChildCount() !== 1) {
        throw new SemanticArgumentCountMismatchError({
          message: 'Decimal128 requires one argument'
        });
      }

      const arg = argumentList.singleExpression()[0];
      const decimal = this.visit(arg);

      return `Decimal128(Decimal(${decimal}))`;
    }
  }
  return Visitor;
};
