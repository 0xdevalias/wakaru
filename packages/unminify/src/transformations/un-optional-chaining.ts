import { mergeComments } from '@wakaru/ast-utils/comments'
import { memberExpressionKindTypes, patternKindTypes } from '@wakaru/ast-utils/kinds'
import { areNodesEqual, isNotNullBinary, isNull, isNullBinary, isTrue, isUndefined, isUndefinedBinary } from '@wakaru/ast-utils/matchers'
import { smartParenthesized } from '@wakaru/ast-utils/parenthesized'
import { removeDeclarationIfUnused } from '@wakaru/ast-utils/scope'
import { createJSCodeshiftTransformationRule } from '@wakaru/shared/rule'
import { negateCondition } from '../utils/condition'
import { makeDecisionTree, makeDecisionTreeWithConditionSplitting, negateDecisionTree } from '../utils/decisionTree'
import type { DecisionTree } from '../utils/decisionTree'
import type { ASTTransformation } from '@wakaru/shared/rule'
import type { ExpressionKind } from 'ast-types/lib/gen/kinds'
import type { ASTPath, ConditionalExpression, Identifier, JSCodeshift, LogicalExpression, MemberExpression, SequenceExpression, SpreadElement } from 'jscodeshift'

/**
 * Indicates whether should the transformation be applied.
 *
 * We use a dirty global variable to prevent the rule from
 * transforming result that doesn't actually have optional chaining.
 *
 * This is to prevent the infinite loop and incorrect transformation
 * since translate decision tree back to the original expression
 * may not be perfect.
 */
let transformed = false

/**
 * Restore optional chaining syntax.
 *
 * TODO: support `loose=false` mode.
 * if (foo != null && foo.length > 0) -> if (foo?.length > 0)
 */
export const transformAST: ASTTransformation = (context) => {
    const { root, j } = context

    const visited = new Set<ASTPath>()

    let passes = 5
    while (passes--) {
        root
            .find(j.ConditionalExpression)
            .forEach((path) => {
                if (visited.has(path)) return
                visited.add(path)

                const result = convertOptionalChaining(j, path)
                if (result) {
                    path.replace(result)
                }
            })

        root
            .find(j.LogicalExpression, { operator: (op: LogicalExpression['operator']) => op === '&&' || op === '||' })
            .forEach((path) => {
                if (visited.has(path)) return
                visited.add(path)

                const result = convertOptionalChaining(j, path)
                if (result) {
                    path.replace(result)
                }
            })
    }
}

function convertOptionalChaining(j: JSCodeshift, path: ASTPath<ConditionalExpression | LogicalExpression>): ExpressionKind | null {
    transformed = false

    const expression = path.node
    // console.log('\n\n>>>', `${picocolors.green(j(expression).toSource())}`)
    const _decisionTree = makeDecisionTreeWithConditionSplitting(j, makeDecisionTree(j, expression, false))
    const isNotNull = isNotNullBinary(j, _decisionTree.condition)
    const decisionTree = isNotNull
        ? negateDecisionTree(j, _decisionTree)
        : _decisionTree
    // renderDebugDecisionTree(j, decisionTree)

    const _result = constructOptionalChaining(j, path, decisionTree, 0)
    if (!transformed || !_result || path.node === _result) return null

    const result = isNotNull ? negateCondition(j, _result) : _result
    // console.log('<<<', `${picocolors.cyan(j(result).toSource())}`)
    mergeComments(result, expression.comments)

    return result
}

function constructOptionalChaining(
    j: JSCodeshift,
    path: ASTPath,
    tree: DecisionTree,
    flag: 0 | 1,
): ExpressionKind | null {
    const { condition, trueBranch, falseBranch } = tree
    const deepestFalseBranch = getDeepestFalseBranch(tree)
    /**
     * if the deepest node is `delete` operator, we should accept true as the
     * condition.
     * @see https://github.com/babel/babel/blob/aaf364a5675daec4dc61095c5fd6df6c9adf71cf/packages/babel-plugin-transform-optional-chaining/src/transform.ts#L251
     */
    if (trueBranch && j.UnaryExpression.check(deepestFalseBranch.condition) && deepestFalseBranch.condition.operator === 'delete') {
        if (!isFalsyBranch(j, trueBranch) && !isTrue(j, trueBranch.condition)) return null
    }
    else if (!isFalsyBranch(j, trueBranch)) return null

    /**
     * Flag 0: Default state, looking for null
     * Flag 1: Null detected, looking for undefined
     */
    if (flag === 0) {
        if (!falseBranch) {
            const nestedAssignment = j(condition).find(j.AssignmentExpression, { left: { type: 'Identifier' } }).nodes()

            const allAssignment = [
                ...nestedAssignment,
                ...(j.AssignmentExpression.check(condition) && j.Identifier.check(condition.left) ? [condition] : []),
            ]
            const result = allAssignment.reduce((acc, curr) => {
                const { left: tempVariable, right: originalVariable } = curr

                return applyOptionalChaining(j, acc, tempVariable as Identifier, originalVariable)
            }, condition)

            allAssignment.forEach((assignment) => {
                if (j.Identifier.check(assignment.left)) {
                    removeDeclarationIfUnused(j, path, assignment.left.name)
                }
            })

            return result
        }

        if (isNullBinary(j, condition)) {
            const { left, right, operator } = condition
            const nonNullExpr = j.NullLiteral.check(left) ? right : left

            const nextFlag = operator === '==' ? 0 : 1
            const cond = constructOptionalChaining(j, path, falseBranch, nextFlag)
            if (!cond) return null

            if (j.AssignmentExpression.check(nonNullExpr) && j.Identifier.check(nonNullExpr.left)) {
                const nestedAssignment = j(nonNullExpr).find(j.AssignmentExpression, { left: { type: 'Identifier' } }).nodes()
                const allAssignment = [nonNullExpr, ...nestedAssignment]
                const result = allAssignment.reduce((acc, curr) => {
                    const { left: tempVariable, right: originalVariable } = curr

                    return applyOptionalChaining(j, acc, tempVariable as Identifier, originalVariable)
                }, cond)

                allAssignment.forEach((assignment) => {
                    if (j.Identifier.check(assignment.left)) {
                        removeDeclarationIfUnused(j, path, assignment.left.name)
                    }
                })

                return result
            }
            else if (j.Identifier.check(left)) {
                return applyOptionalChaining(j, cond, left, undefined)
            }
            else if (j.MemberExpression.check(left)) {
                return applyOptionalChaining(j, cond, left, undefined)
            }
        }

        if (falseBranch) {
            const cond = constructOptionalChaining(j, path, falseBranch, 0)
            if (!cond) return null
            if (isNullBinary(j, condition)) {
                const { left, right } = condition
                const id = j.NullLiteral.check(left) ? right : left
                if (j.Identifier.check(id) || j.MemberExpression.check(id)) {
                    const result = applyOptionalChaining(j, cond, id as any, undefined)
                    transformed = true
                    return result
                }
            }

            const result = applyOptionalChaining(j, cond, condition as any, undefined)
            return j.logicalExpression('||', condition, result)
        }
    }
    else if (flag === 1) {
        if (!falseBranch) return null

        if (isUndefinedBinary(j, condition)) {
            return constructOptionalChaining(j, path, falseBranch, 0)
        }
        return null
    }

    return null
}

function applyOptionalChaining<T extends ExpressionKind>(
    j: JSCodeshift,
    node: T,
    tempVariable: MemberExpression | Identifier,
    targetExpression?: ExpressionKind,
): T {
    // console.log('applyOptionalChaining', node.type, j(node).toSource(), '|', tempVariable ? j(tempVariable).toSource() : null, '|', targetExpression ? j(targetExpression).toSource() : null)

    if (j.MemberExpression.check(node)) {
        if (areNodesEqual(j, node.object, tempVariable)) {
            /**
             * Wrap with parenthesis to ensure the precedence.
             * The output will be a little bit ugly, but it
             * will eventually be cleaned up by prettier.
             */
            const object = targetExpression ? smartParenthesized(j, targetExpression) : node.object
            transformed = true
            return j.optionalMemberExpression(object, node.property, node.computed) as T
        }

        node.object = applyOptionalChaining(j, node.object, tempVariable, targetExpression)
    }

    if ((j.CallExpression.check(node) || j.OptionalCallExpression.check(node))) {
        if ((j.MemberExpression.check(node.callee) || j.OptionalMemberExpression.check(node.callee))) {
            if (j.MemberExpression.check(node.callee.object) && j.Identifier.check(node.callee.property)) {
                if (
                    node.callee.property.name === 'call'
                    && areNodesEqual(j, node.arguments[0], tempVariable)
                ) {
                    const argumentStartsWithThis = areNodesEqual(j, node.arguments[0], tempVariable)
                    const [_, ..._args] = node.arguments
                    const args = argumentStartsWithThis ? _args : node.arguments
                    const optionalCallExpression = j.optionalCallExpression(
                        applyOptionalChaining(j, node.callee.object, tempVariable, targetExpression),
                        args.map((arg) => {
                            return j.SpreadElement.check(arg) ? arg : applyOptionalChaining(j, arg, tempVariable, targetExpression)
                        }),
                    )
                    transformed = true
                    return optionalCallExpression as T
                }

                if (node.callee.property.name === 'apply') {
                    const [_, arg] = node.arguments
                    if (j.SpreadElement.check(arg)) return node

                    const args = j.ArrayExpression.check(arg)
                        ? arg.elements.map(element => element ?? j.identifier('undefined')) as Array<ExpressionKind | SpreadElement>
                        : [j.spreadElement(arg)]
                    const optionalCallExpression = j.optionalCallExpression(
                        applyOptionalChaining(j, node.callee.object, tempVariable, targetExpression),
                        args.map((arg) => {
                            return j.SpreadElement.check(arg) ? arg : applyOptionalChaining(j, arg, tempVariable, targetExpression)
                        }),
                    )
                    transformed = true
                    return optionalCallExpression as T
                }

                if (
                    node.callee.property.name === 'bind'
                    && areNodesEqual(j, node.arguments[0], tempVariable)
                ) {
                    const calleeObj = node.callee.object
                    const isOptional = !j.AssignmentExpression.check(calleeObj.object)
                    const builder = isOptional ? j.optionalMemberExpression : j.memberExpression
                    const memberExpression = builder(
                        applyOptionalChaining(j, calleeObj.object, tempVariable, targetExpression),
                        applyOptionalChaining(j, calleeObj.property, tempVariable, targetExpression),
                        calleeObj.computed,
                    )
                    if (isOptional) transformed = true
                    return memberExpression as T
                }
            }

            if (areNodesEqual(j, node.callee.object, tempVariable)) {
                if (j.Identifier.check(node.callee.property)) {
                    if (node.callee.property.name === 'call') {
                        const optionalCallExpression = j.optionalCallExpression(
                            targetExpression as Identifier,
                            node.arguments.slice(1).map((arg) => {
                                return j.SpreadElement.check(arg) ? arg : applyOptionalChaining(j, arg, tempVariable, targetExpression)
                            }),
                        )
                        transformed = true
                        return optionalCallExpression as T
                    }
                    else if (node.callee.property.name === 'apply') {
                        const [_, arg] = node.arguments
                        if (j.SpreadElement.check(arg)) return node

                        const args = j.ArrayExpression.check(arg)
                            ? arg.elements.map(element => element ?? j.identifier('undefined')) as Array<ExpressionKind | SpreadElement>
                            : [j.spreadElement(arg)]
                        const optionalCallExpression = j.optionalCallExpression(
                            targetExpression as Identifier,
                            args.map((arg) => {
                                return j.SpreadElement.check(arg) ? arg : applyOptionalChaining(j, arg, tempVariable, targetExpression)
                            }),
                        )
                        transformed = true
                        return optionalCallExpression as T
                    }
                }
            }
        }

        if (j.match(node.callee, {
            type: 'SequenceExpression',
            // @ts-expect-error
            expressions: (expressions: ExpressionKind[]) => {
                return expressions.length === 2
                && j.NumericLiteral.check(expressions[0])
                && expressions[0].value === 0
                && areNodesEqual(j, expressions[1], tempVariable)
            },
        })) {
            const target = targetExpression || (node.callee as SequenceExpression).expressions[1]
            const callee = smartParenthesized(j, j.sequenceExpression([j.numericLiteral(0), target]))
            const args = node.arguments.map((arg) => {
                return j.SpreadElement.check(arg) ? arg : applyOptionalChaining(j, arg, tempVariable, targetExpression)
            })
            const optionalCallExpression = j.optionalCallExpression(callee, args)
            transformed = true
            return optionalCallExpression as T
        }

        if (areNodesEqual(j, node.callee, tempVariable)) {
            transformed = true
            const target = targetExpression || node.callee
            return j.optionalCallExpression(target, node.arguments) as T
        }

        const isOptional = j.OptionalCallExpression.check(node)
        const builder = isOptional ? j.optionalCallExpression : j.callExpression
        const callee = applyOptionalChaining(j, node.callee, tempVariable, targetExpression)
        const args = node.arguments.map((arg) => {
            return j.SpreadElement.check(arg) ? arg : applyOptionalChaining(j, arg, tempVariable, targetExpression)
        })
        return builder(callee, args) as T
    }

    if (j.AssignmentExpression.check(node)) {
        if (targetExpression && areNodesEqual(j, node.left, tempVariable)) {
            if (node.right === targetExpression) {
                return targetExpression as T
            }

            if (memberExpressionKindTypes.some(type => type.check(targetExpression)) || patternKindTypes.some(type => type.check(targetExpression))) {
                node = j.assignmentExpression(node.operator, targetExpression as any, node.right) as T
            }
        }
    }

    if (targetExpression && j.Identifier.check(node) && areNodesEqual(j, node, tempVariable)) {
        return smartParenthesized(j, targetExpression) as T
    }

    if (j.UnaryExpression.check(node)) {
        const arg = applyOptionalChaining(j, node.argument, tempVariable, targetExpression)
        node = j.unaryExpression(node.operator, arg, node.prefix) as T
    }

    return node
}

function isFalsyBranch(j: JSCodeshift, tree: DecisionTree | null): boolean {
    if (!tree) return true

    const { condition, trueBranch, falseBranch } = tree

    return (isNull(j, condition) || isUndefined(j, condition))
        && (!trueBranch || isFalsyBranch(j, trueBranch))
        && (!falseBranch || isFalsyBranch(j, falseBranch))
}

function getDeepestFalseBranch(tree: DecisionTree) {
    const { falseBranch } = tree
    if (!falseBranch) return tree

    return getDeepestFalseBranch(falseBranch)
}

export default createJSCodeshiftTransformationRule({
    name: 'un-optional-chaining',
    transform: transformAST,
})
