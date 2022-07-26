# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from . import models
from . import wizard
from . import report

from odoo import api, SUPERUSER_ID

import logging
_logger = logging.getLogger(__name__)

def _create_warehouse_data(cr, registry):
    """ This hook is used to add a default manufacture_pull_id, manufacture
    picking_type on every warehouse. It is necessary if the mrp module is
    installed after some warehouses were already created.
    """
    env = api.Environment(cr, SUPERUSER_ID, {})
    warehouse_ids = env['stock.warehouse'].search([('manufacture_pull_id', '=', False)])
    for warehouse_id in warehouse_ids:
        warehouse_id.write({'manufacture_to_resupply': True})


def _pre_populate_mrp_fields(cr):
    _logger.info("> Begin of pre population of mrp module.")
    _logger.info("Create and populate stock_move.is_done")
    cr.execute("ALTER TABLE stock_move ADD COLUMN is_done BOOLEAN;")
    cr.execute("UPDATE stock_move SET is_done = true WHERE state IN ('done', 'cancel');")
    cr.execute("UPDATE stock_move SET is_done = false WHERE state NOT IN ('done', 'cancel');")

    _logger.info("Create and populate stock_move_line.done_move")
    cr.execute("ALTER TABLE stock_move_line ADD COLUMN done_move BOOLEAN;")
    cr.execute("""
        UPDATE stock_move_line sml
        SET done_move = sm.is_done
        FROM stock_move sm
        WHERE sm.id = sml.move_id;
    """)
    _logger.info("> End of pre population of mrp module.")
