PYTHON ?= python
FACTORY_TEST_MODULES ?= factory.scripts.tests.test_setup_workspace factory.scripts.tests.test_validate_worktree_hygiene_convergence

.PHONY: test-factory-scripts
test-factory-scripts:
	@$(PYTHON) -B factory/scripts/run_factory_tests.py $(FACTORY_TEST_MODULES)
