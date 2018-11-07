/******************************************************************************
    Copyright (C) 2017 - Today: GRAP (http://www.grap.coop)
    @author: Sylvain LE GAL (https://twitter.com/legalsylvain)
    Part of Odoo. See LICENSE file for full copyright and licensing details.
 *****************************************************************************/

/******************************************************************************
    Developpers Note: 
    This module changes the behaviour of the PoS regarding the French Sapin Law.
    In this context, for french Point of Sales, when a pos order is created
    a call to the server will be done, to recover the hash of the order to
    print it on the bill.
    The time for the bill to print will depend on the server processing time.

    1. If you want to change the message printed on the bill, overload the
    function models.Order._prepare_certification_text()

    2. If you want to change the behaviour of the PoS if server is unreachable,
    (for exemple, prevent printing the bill), overload the following functions :
    - ReceiptScreenWidget._handleCertification()
    - ProxyDevice._print_receipt_certification()
******************************************************************************/

'use strict';

odoo.define('l10n_fr_pos_cert.models', function (require) {

    var devices = require('point_of_sale.devices');
    var models = require('point_of_sale.models');
    var screens = require('point_of_sale.screens');
    var DataModel = require('web.DataModel');
    var core = require('web.core');
    var _t = core._t;

    /*************************************************************************
        Extend module.Order:
            Add a new certification_text field that will content a text and
            the hash of the PoS Order, or a warning if hash has not been
            recovered.
     */
    var OrderParent = models.Order.prototype;
    models.Order = models.Order.extend({

        /* Function that return certification text, depending of a hash
         * @param {string} hash: value of the pos_order.l10n_fr_hash
         * @param {string} setting: value of the pos_config.l10n_fr_print_hash
         * @returns {string}: Certification Text that will be printed on the bill
         */
        _prepare_certification_text: function (hash, setting) {
            if (setting === 'no_print'){
                return '';
            }
            if (hash){
                return _t('Certification Number: ') + hash.substring(0, 10) + '...' + hash.substring(hash.length - 10);
            }
            return _t("Because of a network problem, this ticket could not be certified.");
        },

        set_hash: function(hash, setting) {
            var certification_text = this._prepare_certification_text(hash, setting);
            this.set({
                hash: hash,
                certification_text: certification_text,
            });
        },

        export_as_JSON: function() {
            var order = OrderParent.export_as_JSON.apply(this, arguments);
            order.certification_text = this.get('certification_text');
            return order;
        },

        // @override
        // Prevents saving as unpaid if valid hash has been set on the order
        save_to_db: function () {
            var changes = this.changedAttributes();

            var hashed = false;
            _.each(changes, function (value, key) {
                if (['hash', 'certification_text'].indexOf(key) === -1){
                    hashed = false;
                    return; // abort if another other data has been set
                }
                if (key === 'hash') {
                    hashed = value ? true : false;
                }
            });

            if (!hashed) {
                OrderParent.save_to_db.apply(this, arguments);
            }
        },

    });

    /*************************************************************************
        Extend module.PosModel:
            - Overload load_server_data(). Load extra certification settings
              at the end of the PoS load.
            - Overload _save_to_server() and store if the order has been
              correctly created in the promise 'certification_deferred'
     */
    var PosModelParent = models.PosModel.prototype;
    models.PosModel = models.PosModel.extend({

       /* Setter/getter for the promise that will be resolved,
        * when the hash of the saved order is known
        */
        _getCertificationDeferred: function (make_new) {
            if (!this.certification_deferred || make_new) {
                this.certification_deferred = new $.Deferred();
            }
            return this.certification_deferred;
        },

        _resetCertificationDeferred: function () {
            this.certification_deferred = null;
        },

        load_server_data: function(){
            var self = this;

            // Call super
            var loaded = PosModelParent.load_server_data.apply(this, arguments);

            // Load Extra Settings
            return $.when(loaded).then(function(){
                self.chrome.loading_message(_t('Loading Certification Setting'));
                var PosConfigModel = new DataModel('pos.config');
                return PosConfigModel.call(
                    'get_setting_l10n_fr_print_hash', [self.config.id], false
                ).then(function (setting) {
                    self.config.l10n_fr_print_hash = setting;
                });
            });
        },

        _save_to_server: function (orders, options) {
            var self = this;

            // Get PoS Config Settings
            var setting = self.config.l10n_fr_print_hash;

            if (setting === 'no_print'){
                return PosModelParent._save_to_server.apply(this, arguments);
            }
            // Create a new promise that will resolved after the call to get the hash
            var certification_deferred = this._getCertificationDeferred(true);

            var current_order = self.get('selectedOrder');
            if (current_order && !current_order.get('hash')){
                // Init hash (and description that will be used, if server is unreachable)
                current_order.set_hash(false, setting);
            }

            // Store the current order, in case we need to reprint
            this.set('latestOrder', current_order);

            return PosModelParent._save_to_server.apply(this, arguments).then(function(server_ids) {
                if (server_ids.length) {
                    // Try to get hash of saved orders, if required
                    var posOrderModel = new DataModel('pos.order');
                    return posOrderModel.call(
                        'get_certification_information', [server_ids], false
                    ).then(function (results) {
                        var hash = false;
                        _.each(results, function(result){
                            if (result.pos_reference.indexOf(current_order.uid) > 0) {
                                hash = result.l10n_fr_hash;
                                current_order.set_hash(hash, setting);
                                return server_ids;
                            }
                        });
                        certification_deferred.resolve(hash);
                        return server_ids;
                    }).fail(function (error, event){
                        certification_deferred.reject();
                        return server_ids;
                    });
                }
                certification_deferred.reject();
            }, function error() {
                certification_deferred.reject();
            });
        },

    });

    /*************************************************************************
        [if iface_print_via_proxy IS NOT enabled]

        Extend ReceiptScreenWidget:
            - overload show() function to wait for the order hash,
              before printing the bill.
     */
    var ReceiptScreenWidgetShowParent = screens.ReceiptScreenWidget.prototype.show;
    screens.ReceiptScreenWidget.include({

        show: function(){
            var self = this;
            var selfArgs = arguments;
            var setting = this.pos.config.l10n_fr_print_hash;
            if (setting === 'no_print'){
                // Direct Call
                ReceiptScreenWidgetShowParent.apply(this, arguments);
            } else {
                // Wait for Promise
                this._handleCertification().always(function () {
                    ReceiptScreenWidgetShowParent.apply(self, selfArgs);
                });
            }
        },

        _handleCertification: function () {
            return this.pos._getCertificationDeferred();
        },
    });

    /*************************************************************************
        [if iface_print_via_proxy IS enabled]

        Extend module.ProxyDevice:
            - overload print_receipt() function to wait for the order hash,
              before printing the bill.
     */
    var ProxyDevicePrintReceiptParent = devices.ProxyDevice.prototype.print_receipt;
    devices.ProxyDevice.include({

        print_receipt: function(receipt){
            var self = this;
            var selfArgs = arguments;
            var setting = this.pos.config.l10n_fr_print_hash;
            if (receipt){
                if (setting === 'no_print'){
                    ProxyDevicePrintReceiptParent.apply(this, arguments);
                } else {
                    this._print_receipt_certification(receipt).always(function () {
                        ProxyDevicePrintReceiptParent.apply(self, selfArgs);
                        self.pos._resetCertificationDeferred();
                    });
                }
            } else {
                // without receipt
                ProxyDevicePrintReceiptParent.apply(this, [receipt]);
            }
        },

        _print_receipt_certification: function(receipt){
            if (this.pos.get('latestOrder').get('hash')) {
                return $.when();
            }
            return this.pos._getCertificationDeferred();
        },
    });

});
