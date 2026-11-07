// agent-platform (ORDER #2963): the shared agent-team module any department's app loads.
// Slice 1: the department config, the fence and the department column. The runner,
// team page, review queue, edit chain, Producer and reviewer watch move in next.
'use strict';

const { FENCE, forbidden } = require('./lib/fence');
const { defineDepartment, isHead, isInstructionApprover, BASE_LAWS } = require('./lib/config');
const { SHARED_TABLES, checkDepartmentId, departmentMigrationSql, ensureDepartmentColumn } = require('./lib/schema');

module.exports = {
  FENCE, forbidden,
  defineDepartment, isHead, isInstructionApprover, BASE_LAWS,
  SHARED_TABLES, checkDepartmentId, departmentMigrationSql, ensureDepartmentColumn,
};
